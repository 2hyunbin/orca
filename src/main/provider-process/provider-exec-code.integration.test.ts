import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Duplex } from 'node:stream'
import { runProcess } from '@orca/process-host'
import * as processHost from '@orca/process-host'
import { collectProviderExecCode, prepareProviderExecCode } from './provider-exec-code'
import { readPosixProcessRow } from './provider-process-row-read'
import { spawnProviderExecControl } from './provider-exec-control'
import { providerExecChannel } from './provider-exec-channel'
import { settleProviderExec } from './provider-exec-settlement'

// These tests execute only our internal C fixture; they never start an agent or Electron.
describe.skipIf(process.platform === 'win32')('provider executable retention', () => {
  let root: string
  let binary: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-provider-code-test-'))
    binary = join(root, 'orca-provider-exec')
    const built = await runProcess({
      program: 'cc',
      args: [
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        resolve('native/provider-exec/provider-exec.c'),
        '-o',
        binary
      ],
      timeoutMs: 30_000
    })
    expect(built.code, built.stderr).toBe(0)
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('accepts terminal acknowledgement followed by EOF in the same callback', async () => {
    const endpoint = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback()
      }
    })
    const lost = vi.fn()
    const channel = providerExecChannel(endpoint, lost)
    const reply = channel.next()
    channel.send('RETIRE fixture', 'RETIRED fixture')
    endpoint.emit('data', Buffer.from('RETIRED fixture\n'))
    endpoint.emit('end')
    expect(await reply).toBe('RETIRED fixture')
    expect(lost).not.toHaveBeenCalled()
    channel.stop()
  })

  it('retains old code through source removal, owner close and inherited shell use, then collects it', async () => {
    const cache = join(root, 'cache')
    await mkdir(cache)
    const sourcePath = join(root, 'source-executable')
    await copyFile(binary, sourcePath)
    const sha256 = createHash('sha256')
      .update(await readFile(binary))
      .digest('hex')
    const denied = join(root, 'noexec-cache')
    await mkdir(denied)
    const originalRun = runProcess
    const noexec = vi.spyOn(processHost, 'runProcess').mockImplementation((spec, capture) => {
      if (spec.program.startsWith(denied)) {
        return Promise.reject(Object.assign(new Error('Execution denied'), { code: 'EACCES' }))
      }
      return originalRun(spec, capture)
    })
    const first = await prepareProviderExecCode({ executable: sourcePath, sha256 }, [
      denied,
      cache
    ]).finally(() => noexec.mockRestore())
    expect(first.executable.startsWith(cache)).toBe(true)
    const second = await prepareProviderExecCode({ executable: binary, sha256 }, [cache])
    const lost = vi.fn()
    const control = spawnProviderExecControl(
      { command: '/bin/sh', args: ['-c', 'printf READY; IFS= read -r finish; printf FINAL'] },
      first,
      { closeRequest: 'stdin-end-and-sigterm', onProtectionLost: lost }
    )
    const holder = control.child
    holder.stderr.resume()
    const readyOutput = once(holder.stdout, 'data')
    const outputEnded = once(holder.stdout, 'end')
    let output = ''
    holder.stdout.on('data', (chunk) => {
      output += chunk
    })
    try {
      expect(holder.pid).toBeGreaterThan(1)
      expect((await control.startup).kind).toBe('released')
      expect(String((await readyOutput)[0])).toBe('READY')
      expect(control.rootVerdict).toBe('live')
      expect(await control.execStatus).toEqual({ kind: 'closed' })
      await rm(sourcePath)
      await first.close()
      expect(() => first.holdFd()).toThrow('stopped')
      const codeRoot = dirname(dirname(second.executable))
      const row = await readPosixProcessRow(holder.pid ?? 0)
      if (!row || row === 'unverifiable') {
        throw new Error('Could not identify the fixture holder')
      }
      const marker = Buffer.from(
        JSON.stringify({ pid: holder.pid, start: row.startedAt })
      ).toString('base64url')
      const stage = join(codeRoot, `stage-${marker}.fixture`)
      await mkdir(stage, { mode: 0o700 })
      await collectProviderExecCode(codeRoot, second.executable, second.holdFd())
      expect(existsSync(first.executable)).toBe(true)
      expect(existsSync(stage)).toBe(true)
      const usable = await runProcess({
        program: first.executable,
        args: ['probe-lock', join(dirname(first.executable), 'hold')],
        stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', second.holdFd()]
      })
      expect(usable.code).toBe(3) // A descriptor naming a different copy is refused.
      holder.stdin.end('done\n')
      expect(await control.rootExit).toEqual({ code: 0, signal: null, processless: false })
      expect(control.rootVerdict).toBe('exited')
      await outputEnded
      expect(output).toBe('READYFINAL')
      // Physical exit did not retire the independently held watcher/code.
      await collectProviderExecCode(codeRoot, second.executable, second.holdFd())
      expect(existsSync(first.executable)).toBe(true)
      expect((await control.operation('PROBE')).group).toBe('exited')
      expect(
        await settleProviderExec(control, {
          reason: 'natural',
          closeRequest: 'stdin-end',
          lifetime: 'one-shot'
        })
      ).toEqual({
        root: 'exited',
        group: 'exited',
        tree: null,
        output: 'complete',
        terminal: 'retired'
      })
      await collectProviderExecCode(codeRoot, second.executable, second.holdFd())
      expect(existsSync(first.executable)).toBe(false)
      expect(existsSync(stage)).toBe(false)
      expect(existsSync(second.executable)).toBe(true)
      expect(lost).not.toHaveBeenCalled()
      for (const missing of [false, true]) {
        const probe = spawnProviderExecControl(
          {
            command: missing ? join(root, 'missing-provider') : '/bin/sh',
            args: missing ? [] : ['-c', 'exit 127']
          },
          second,
          { closeRequest: 'stdin-end', onProtectionLost: lost }
        )
        probe.child.stdout.resume()
        probe.child.stderr.resume()
        expect((await probe.startup).kind).toBe('released')
        expect((await probe.rootExit).code).toBe(127)
        const status = await probe.execStatus
        const failure = status.kind === 'failed' ? status : null
        expect(status.kind).toBe(missing ? 'failed' : 'closed')
        expect(failure?.stage ?? null).toBe(missing ? 'exec' : null)
        expect(failure && 'code' in failure.error ? failure.error.code : null).toBe(
          missing ? 'ENOENT' : null
        )
        await settleProviderExec(probe, {
          reason: 'natural',
          closeRequest: 'stdin-end',
          lifetime: 'one-shot'
        })
      }
      const stubborn = spawnProviderExecControl(
        { command: '/bin/sh', args: ['-c', 'trap "" TERM; printf READY; exec /bin/sleep 30'] },
        second,
        { closeRequest: 'stdin-end-and-sigterm', onProtectionLost: lost }
      )
      stubborn.child.stderr.resume()
      try {
        await once(stubborn.child.stdout, 'data')
        const closing = settleProviderExec(stubborn, {
          reason: 'close',
          closeRequest: 'stdin-end-and-sigterm',
          lifetime: 'session'
        })
        expect(
          settleProviderExec(stubborn, {
            reason: 'natural',
            closeRequest: 'stdin-end',
            lifetime: 'one-shot'
          })
        ).toBe(closing)
        expect(await closing).toEqual({
          root: 'exited',
          group: 'exited',
          tree: null,
          output: 'complete',
          terminal: 'retired'
        })
        expect((await stubborn.rootExit).signal).toBe('SIGKILL')
      } finally {
        stubborn.disconnect()
      }
      expect(lost).not.toHaveBeenCalled()
    } finally {
      control.disconnect()
      if (holder.exitCode === null && holder.signalCode === null) {
        holder.kill('SIGKILL')
        await control.rootExit
      }
      await first.close()
      await second.close()
    }
  }, 15_000)
})
