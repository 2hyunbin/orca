import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import { getAppEnvironment, setAppEnvironment } from '../../shared/app-environment'
import { spawnManagedProviderProcess } from './managed-provider-process'
import { readPosixProcessRow } from './provider-process-row-read'
import { recoverProviderLaunches } from './provider-process-ledger'
import {
  retainCodexHomeWriter,
  withCodexHomeProcessLock
} from '../codex-cli/codex-home-process-lock'

const roots: string[] = []
const children: ReturnType<typeof spawnProcess>[] = []
afterEach(async () => {
  // Every PID is returned by this test's launch; never select processes by a pattern.
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function folder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nc-perf-direct-'))
  roots.push(root)
  return root
}

async function readWhenWritten(path: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const text = await readFile(path, 'utf8').catch(() => '')
    if (text) {
      return text
    }
    await delay(25)
  }
  throw new Error(`fixture did not write ${path}`)
}

describe.runIf(process.platform !== 'win32')('direct provider ownership', () => {
  it('keeps the actual parent, final output and status while reaping inherited group pipes', async () => {
    const root = await folder()
    const toolFile = join(root, 'tool-pid')
    const script = `
      const {spawn}=require('node:child_process');
      const tool=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},60000)'],{stdio:['ignore',1,2]});
      require('node:fs').writeFileSync(process.argv[1],String(tool.pid));
      process.stdout.write(JSON.stringify({pid:process.pid,parent:process.ppid})+'\\n');
      setTimeout(()=>{process.stdout.write('final-record\\n');process.exit(7)},150);
    `
    const managed = spawnManagedProviderProcess(
      { command: process.execPath, args: ['-e', script, toolFile] },
      { site: 'direct-test' }
    )
    children.push(managed.child)
    let output = ''
    managed.child.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    const physical = vi.fn()
    managed.onExit(physical)
    const toolPid = Number(await readWhenWritten(toolFile))
    try {
      const exit = await managed.completion
      expect(exit).toEqual({ code: 7, signal: null, processless: false })
      expect(physical).toHaveBeenCalledOnce()
      expect(JSON.parse(output.split('\n')[0] ?? '')).toEqual({
        pid: managed.child.pid,
        parent: process.pid
      })
      expect(output).toContain('final-record\n')
      expect(await readPosixProcessRow(toolPid)).toBeNull()
      expect(await managed.verifyWriters()).toBe(true)
      const reap = vi.fn(async () => 'exited' as const)
      await managed.close({ capture: async () => {}, reap, treeVerdict: 'exited' })
      expect(reap).toHaveBeenCalledOnce()
    } finally {
      // Exact fixture PID, recorded before the assertion that might fail.
      try {
        process.kill(toolPid, 'SIGKILL')
      } catch {
        /* Already reaped. */
      }
      await managed.close()
    }
  })

  it('shares normal close, escalates a TERM-ignoring group, and preserves user Node environment', async () => {
    const managed = spawnManagedProviderProcess(
      {
        command: process.execPath,
        args: [
          '-e',
          'process.on("SIGTERM",()=>{});process.stdout.write(JSON.stringify({options:process.env.NODE_OPTIONS,electron:process.env.ELECTRON_RUN_AS_NODE}));setInterval(()=>{},60000)'
        ]
      },
      {
        site: 'direct-close-test',
        inheritedEnv: { ...process.env, NODE_OPTIONS: '--no-warnings', ELECTRON_RUN_AS_NODE: '1' }
      }
    )
    children.push(managed.child)
    const output = await new Promise<string>((resolve) =>
      managed.child.stdout.once('data', (chunk) => resolve(String(chunk)))
    )
    expect(JSON.parse(output)).toEqual({ options: '--no-warnings' })
    const [one, two] = await Promise.all([managed.close(), managed.close()])
    expect(one).toMatchObject({ root: 'exited', tree: 'exited' })
    expect(two).toEqual(one)
    expect(await managed.completion).toMatchObject({ signal: 'SIGKILL' })
  })

  it('recovers recorded disposable members, skips live owners and refuses changed identity', async () => {
    const root = await folder()
    const directory = join(root, 'provider-processes')
    await mkdir(directory)
    const saved = getAppEnvironment()
    setAppEnvironment({
      ...saved,
      getPath: (key) => (key === 'userData' ? root : saved.getPath(key))
    })
    const spawnFixture = (): ReturnType<typeof spawnProcess> => {
      const child = spawnProcess({
        program: process.execPath,
        args: ['-e', 'setInterval(()=>{},60000)'],
        detached: true
      })
      child.stdout.resume()
      child.stderr.resume()
      children.push(child)
      return child
    }
    const stale = spawnFixture(),
      live = spawnFixture(),
      changed = spawnFixture()
    try {
      // Darwin lstart identities must predate the scan's second.
      await delay(1_100)
      const owner = await readPosixProcessRow(process.pid)
      if (!owner || owner === 'unverifiable') {
        throw new Error('test owner identity unreadable')
      }
      const record = async (
        child: ReturnType<typeof spawnFixture>,
        liveOwner: boolean,
        mismatch: boolean
      ): Promise<void> => {
        if (!child.pid) {
          throw new Error('test child did not spawn')
        }
        const member = await readPosixProcessRow(child.pid)
        if (!member || member === 'unverifiable') {
          throw new Error('test member identity unreadable')
        }
        const token = randomUUID()
        await writeFile(
          join(directory, `${token}.json`),
          JSON.stringify({
            version: 1,
            origin: 'direct',
            token,
            directory,
            createdAt: Date.now(),
            pgid: child.pid,
            owner: liveOwner ? owner : { pid: 9_999_999, pgid: 9_999_999, startedAt: 'gone' },
            members: [{ ...member, ...(mismatch ? { startedAt: 'changed' } : {}) }]
          })
        )
      }
      await record(stale, false, false)
      await record(live, true, false)
      await record(changed, false, true)
      await recoverProviderLaunches()
      expect(stale.exitCode !== null || stale.signalCode !== null).toBe(true)
      expect(live.exitCode).toBeNull()
      expect(live.signalCode).toBeNull()
      expect(changed.exitCode).toBeNull()
      expect(changed.signalCode).toBeNull()
    } finally {
      setAppEnvironment(saved)
    }
  })
})

it.runIf(process.platform !== 'win32')(
  'keeps a captured refresh writer excluded after its wrapper exits and its group changes',
  async () => {
    const root = await folder()
    const writerFile = join(root, 'writer-pid')
    const escapedFile = join(root, 'escaped')
    const python = [
      'import os, sys, time',
      `open(${JSON.stringify(writerFile)}, 'w').write(str(os.getpid()))`,
      'sys.stdin.readline()',
      'os.setsid()',
      `open(${JSON.stringify(escapedFile)}, 'w').write('ready')`,
      'time.sleep(60)'
    ].join('\n')
    const managed = spawnManagedProviderProcess(
      {
        command: process.execPath,
        args: [
          '-e',
          `
    const writer=require('node:child_process').spawn('/usr/bin/python3',['-c',${JSON.stringify(python)}],{stdio:['pipe','inherit','inherit']});
    process.stdin.on('data',chunk=>writer.stdin.write(chunk));
    setInterval(()=>{},60000);
  `
        ]
      },
      { site: 'escaped-writer-test' }
    )
    children.push(managed.child)
    managed.child.stdout.resume()
    const writerPid = Number(await readWhenWritten(writerFile))
    const home = `direct-test-${randomUUID()}`
    try {
      await delay(1_100)
      await expect(managed.verifyWriters()).resolves.toBe(false)
      managed.child.stdin.write('escape\n')
      await readWhenWritten(escapedFile)
      await managed.close()
      retainCodexHomeWriter(home, managed.verifyWriters)
      await expect(withCodexHomeProcessLock(home, async () => 'unsafe')).rejects.toThrow(
        'still using this account home'
      )
      await expect(withCodexHomeProcessLock(`${home}-other`, async () => 'other')).resolves.toBe(
        'other'
      )
      process.kill(writerPid, 'SIGKILL')
      await vi.waitFor(async () => expect(await readPosixProcessRow(writerPid)).toBeNull())
      await expect(withCodexHomeProcessLock(home, async () => 'safe')).resolves.toBe('safe')
    } finally {
      try {
        process.kill(writerPid, 'SIGKILL')
      } catch {
        /* Already gone. */
      }
      await managed.close()
    }
  }
)
