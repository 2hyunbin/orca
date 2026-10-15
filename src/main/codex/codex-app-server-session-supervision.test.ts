import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROVIDER_GROUP_MAX_STOP_MS,
  PROVIDER_STDIN_END_GRACE_MS
} from '../provider-process/provider-group-watchdog'
import type { CodexAppServerSpawn } from './codex-app-server-process-tree-kill'
import { CodexAppServerTimeoutError, runCodexAppServerSession } from './codex-app-server-session'
import { classifyCodexTrustGrantError } from './codex-trust-grant-telemetry'
import {
  alive,
  createSupervisedProbeRig,
  waitFor,
  type SupervisedProbeRig
} from './supervised-probe-owner.test-fixture'

// Answers initialize, then nothing; it ignores its stdin end, as a wedged Codex can.
const WEDGED_APP_SERVER = String.raw`
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n')
  }
})
`

const OWNER = String.raw`
import { runCodexAppServerSession } from './codex-app-server-session'
void runCodexAppServerSession(
  { command: process.env.ORCA_TEST_STAND_IN!, cliPath: null, args: ['app-server'], timeoutMs: 120_000 },
  () => new Promise<never>(() => {})
).catch(() => {})
setInterval(() => {}, 60_000)
`

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
let rig: SupervisedProbeRig | null = null

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  rig?.cleanup()
  rig = null
})

type CapturedSpawn = { program: string; args: string[]; options: Record<string, unknown> }

function captureSpawn(): { spawnImpl: CodexAppServerSpawn; calls: CapturedSpawn[] } {
  const calls: CapturedSpawn[] = []
  return {
    calls,
    spawnImpl: (program, args, options) => {
      calls.push({ program, args, options })
      throw new Error('spawn captured')
    }
  }
}

describe('short-lived Codex app-server session spawn', () => {
  it('spawns a POSIX session directly as the leader of its own group', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const { spawnImpl, calls } = captureSpawn()

    await expect(
      runCodexAppServerSession(
        { command: '/bin/codex', cliPath: null, args: ['app-server'], timeoutMs: 1_000 },
        async () => null,
        spawnImpl
      )
    ).rejects.toThrow('spawn captured')

    const [{ program, args, options }] = calls
    expect(program).toBe('/bin/codex')
    expect(args).toEqual(['app-server'])
    expect(options.detached).toBe(true)
  })

  it('spawns a Windows session directly, as before', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const { spawnImpl, calls } = captureSpawn()

    await expect(
      runCodexAppServerSession(
        { command: 'C:\\codex.exe', cliPath: null, args: ['app-server'], timeoutMs: 1_000 },
        async () => null,
        spawnImpl
      )
    ).rejects.toThrow('spawn captured')

    const [{ program, args, options }] = calls
    expect(program).toBe('C:\\codex.exe')
    expect(args).toEqual(['app-server'])
    expect(options).not.toHaveProperty('detached')
  })
})

describe.runIf(process.platform !== 'win32')('group-led Codex app-server sessions', () => {
  it('stops a wedged session at its deadline with SIGTERM to its whole group', async () => {
    rig = createSupervisedProbeRig()
    const standIn = rig.writeStandIn('codex', WEDGED_APP_SERVER)

    const readPids = rig.readPids
    const reported: { pids?: { provider: number; grandchild: number } } = {}
    // The deadline starts at spawn, so it outlasts the stand-in's whole start budget: a slow host
    // fails the pid read inside that budget instead of stopping a stand-in that never armed.
    const startBudgetMs = 8_000
    const session = runCodexAppServerSession(
      {
        command: standIn,
        cliPath: null,
        args: ['app-server'],
        env: rig.env,
        timeoutMs: startBudgetMs + 2_000
      },
      async () => {
        reported.pids = await readPids(startBudgetMs)
        return new Promise<never>(() => {})
      }
    )

    await expect(session).rejects.toBeInstanceOf(CodexAppServerTimeoutError)
    const { pids } = reported
    expect(pids).toBeDefined()
    if (!pids) {
      return
    }
    // Graceful first: the old deadline SIGKILLed the root, which a Codex mid-write cannot survive.
    expect(existsSync(rig.signalFile) && readFileSync(rig.signalFile, 'utf8')).toBe('SIGTERM')
    expect(alive(pids.provider)).toBe(false)
    // The group ladder reaches a descendant that ignores SIGTERM; a root-only kill misses it.
    expect(alive(pids.grandchild)).toBe(false)
  })

  it('drains, then stops the session group, when its owner is SIGKILLed mid-session', async () => {
    rig = createSupervisedProbeRig()
    const standIn = rig.writeStandIn('codex', WEDGED_APP_SERVER)
    const bundle = await rig.bundleOwner(OWNER, __dirname)
    const owner = rig.launchOwner(bundle, { ORCA_TEST_STAND_IN: standIn })
    const pids = await rig.readPids()

    owner.kill('SIGKILL')

    expect(
      await waitFor(
        () => !alive(pids.provider) && !alive(pids.grandchild),
        PROVIDER_GROUP_MAX_STOP_MS + 1_000
      )
    ).toBe(true)
    // A gone owner gets the close its owner makes: the stdin end, its grace, and only then SIGTERM.
    const events = rig.readEvents()
    expect(events['stdin-end']).toBeDefined()
    expect((events.SIGTERM ?? 0) - (events['stdin-end'] ?? 0)).toBeGreaterThanOrEqual(
      PROVIDER_STDIN_END_GRACE_MS - 50
    )
  })

  it('reports a missing Codex binary as the spawn error, not an early exit', async () => {
    rig = createSupervisedProbeRig()
    const error = await runCodexAppServerSession(
      {
        command: join(rig.dir, 'missing', 'codex'),
        cliPath: null,
        args: ['app-server'],
        timeoutMs: 5_000
      },
      async () => null
    ).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'ENOENT' })
    expect(classifyCodexTrustGrantError(error)).toBe('binary-missing')
  })
})
