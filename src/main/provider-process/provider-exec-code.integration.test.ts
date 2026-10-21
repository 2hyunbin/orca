import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runProcess, spawnProcess } from '@orca/process-host'
import { collectProviderExecCode, prepareProviderExecCode } from './provider-exec-code'
import { readPosixProcessRow } from './provider-process-row-read'

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

  it('retains old code through source removal, owner close and inherited shell use, then collects it', async () => {
    const cache = join(root, 'cache')
    await mkdir(cache)
    const sourcePath = join(root, 'source-executable')
    await copyFile(binary, sourcePath)
    const sha256 = createHash('sha256')
      .update(await readFile(binary))
      .digest('hex')
    const first = await prepareProviderExecCode({ executable: sourcePath, sha256 }, cache)
    const second = await prepareProviderExecCode({ executable: binary, sha256 }, cache)
    const holder = spawnProcess({
      program: '/bin/sh',
      args: ['-c', 'printf READY; IFS= read -r finish'],
      stdio: ['pipe', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', first.holdFd()]
    })
    const exited = once(holder, 'exit')
    try {
      expect(holder.pid).toBeGreaterThan(1)
      expect(String((await once(holder.stdout, 'data'))[0])).toBe('READY')
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
      await exited
      await collectProviderExecCode(codeRoot, second.executable, second.holdFd())
      expect(existsSync(first.executable)).toBe(false)
      expect(existsSync(stage)).toBe(false)
      expect(existsSync(second.executable)).toBe(true)
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) {
        holder.kill('SIGKILL')
        await exited
      }
      await first.close()
      await second.close()
    }
  }, 15_000)
})
