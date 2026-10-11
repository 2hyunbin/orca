import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stop = vi.hoisted(() => ({
  identity: vi.fn<(pid: number) => Promise<'match' | 'mismatch' | 'unknown'>>(),
  kill: vi.fn<
    (
      runtimeDir: string,
      socketPath: string,
      tokenPath: string,
      protocolVersion: number
    ) => Promise<{ killed: boolean; liveOwnerSurvived: boolean }>
  >(),
  detectColdRestore: vi.fn<(sessionId: string) => Promise<unknown>>(),
  sessions: vi.fn<() => Promise<{ sessionId: string }[] | null>>()
}))
vi.mock('./daemon-pid-identity', () => ({ inspectDaemonProcessIdentity: stop.identity }))
vi.mock('./daemon-stale-kill', () => ({ killStaleDaemon: stop.kill }))
vi.mock('./history-reader', () => ({
  HistoryReader: class {
    detectColdRestore(sessionId: string): Promise<unknown> {
      return stop.detectColdRestore(sessionId)
    }
  }
}))
vi.mock('./daemon-provider-routing', () => ({
  listEveryDaemonGeneration: () => stop.sessions()
}))
vi.mock('./daemon-launch-paths', () => ({ getDaemonHistoryDir: () => '/unused' }))

import {
  hasNewerProtocolDaemonHold,
  readNewerDaemonHold,
  reopenNewerDaemonTerminals,
  setNewerProtocolDaemons
} from './daemon-newer-protocol-hold'
import type { DaemonProvider } from './daemon-provider-routing'
import { getDaemonPidPath } from './daemon-spawner'
import { PROTOCOL_VERSION } from './types'

const NEWER = PROTOCOL_VERSION + 1
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the census is mocked; the provider is only passed through.
const provider = {} as DaemonProvider
let runtimeDir: string

function writeNewerRecord(): void {
  writeFileSync(
    getDaemonPidPath(runtimeDir, NEWER),
    JSON.stringify({ pid: 4242, startedAtMs: 1, launchNonce: 'n' })
  )
  writeFileSync(join(runtimeDir, `daemon-v${NEWER}.token`), 'secret')
}

beforeEach(() => {
  vi.clearAllMocks()
  runtimeDir = mkdtempSync(join(tmpdir(), 'orca-newer-hold-'))
  stop.sessions.mockResolvedValue([])
  stop.detectColdRestore.mockResolvedValue(null)
  stop.kill.mockResolvedValue({ killed: true, liveOwnerSurvived: false })
  setNewerProtocolDaemons(runtimeDir, [])
})

afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true })
})

describe('readNewerDaemonHold', () => {
  it('holds nothing without a newer daemon, so older-daemon adoption is untouched', async () => {
    await expect(readNewerDaemonHold('s1', provider)).resolves.toEqual({ held: false })
    expect(stop.sessions).not.toHaveBeenCalled()
  })

  it('holds nothing for stale newer artifacts', async () => {
    setNewerProtocolDaemons(runtimeDir, [{ protocolVersion: NEWER, verdict: 'exited' }])
    expect(hasNewerProtocolDaemonHold()).toBe(false)
    await expect(readNewerDaemonHold('s1', provider)).resolves.toEqual({ held: false })
  })

  it.each(['live', 'unverifiable'] as const)(
    'holds an unclaimed session while a newer daemon is %s',
    async (verdict) => {
      setNewerProtocolDaemons(runtimeDir, [{ protocolVersion: NEWER, verdict }])
      stop.detectColdRestore.mockResolvedValue({
        snapshotAnsi: 'hello',
        scrollbackAnsi: '',
        rehydrateSequences: '',
        cwd: '/w',
        cols: 80,
        rows: 24,
        modes: { alternateScreen: false }
      })
      const hold = await readNewerDaemonHold('s1', provider)
      expect(hold.held).toBe(true)
      expect(hold.held && hold.restoredScreen?.scrollback.startsWith('hello')).toBe(true)
    }
  )

  it('releases a session an adopted daemon owns', async () => {
    setNewerProtocolDaemons(runtimeDir, [{ protocolVersion: NEWER, verdict: 'live' }])
    stop.sessions.mockResolvedValue([{ sessionId: 's1' }])
    await expect(readNewerDaemonHold('s1', provider)).resolves.toEqual({ held: false })
  })

  it('holds when the adopted inventory cannot answer', async () => {
    setNewerProtocolDaemons(runtimeDir, [{ protocolVersion: NEWER, verdict: 'live' }])
    stop.sessions.mockResolvedValue(null)
    await expect(readNewerDaemonHold('s1', provider)).resolves.toEqual({
      held: true,
      restoredScreen: null
    })
  })
})

describe('reopenNewerDaemonTerminals', () => {
  beforeEach(() => {
    writeNewerRecord()
    setNewerProtocolDaemons(runtimeDir, [{ protocolVersion: NEWER, verdict: 'live' }])
  })

  it('releases the hold once the verified daemon is confirmed exited', async () => {
    stop.identity.mockResolvedValueOnce('match').mockResolvedValueOnce('mismatch')
    await expect(reopenNewerDaemonTerminals()).resolves.toEqual({ reopened: true })
    expect(stop.kill).toHaveBeenCalledWith(
      runtimeDir,
      expect.stringContaining(`v${NEWER}`),
      join(runtimeDir, `daemon-v${NEWER}.token`),
      NEWER
    )
    expect(hasNewerProtocolDaemonHold()).toBe(false)
  })

  it('reopens nothing when the daemon survives the stop', async () => {
    stop.identity.mockResolvedValue('match')
    stop.kill.mockResolvedValue({ killed: false, liveOwnerSurvived: true })
    await expect(reopenNewerDaemonTerminals()).resolves.toEqual({ reopened: false })
    expect(hasNewerProtocolDaemonHold()).toBe(true)
  })

  it('reopens nothing when a stop reports success but the pid is still that daemon', async () => {
    stop.identity.mockResolvedValue('match')
    await expect(reopenNewerDaemonTerminals()).resolves.toEqual({ reopened: false })
    expect(hasNewerProtocolDaemonHold()).toBe(true)
  })

  it('never signals or edits files for a pid it cannot identify', async () => {
    stop.identity.mockResolvedValue('unknown')
    await expect(reopenNewerDaemonTerminals()).resolves.toEqual({ reopened: false })
    expect(stop.kill).not.toHaveBeenCalled()
    expect(readdirSync(runtimeDir).sort()).toEqual([
      `daemon-v${NEWER}.pid`,
      `daemon-v${NEWER}.token`
    ])
    expect(hasNewerProtocolDaemonHold()).toBe(true)
  })

  it('treats a daemon that already exited as confirmed without signalling', async () => {
    stop.identity.mockResolvedValue('mismatch')
    await expect(reopenNewerDaemonTerminals()).resolves.toEqual({ reopened: true })
    expect(stop.kill).not.toHaveBeenCalled()
  })

  it('treats a record the daemon removed on exit as confirmed', async () => {
    rmSync(getDaemonPidPath(runtimeDir, NEWER))
    await expect(reopenNewerDaemonTerminals()).resolves.toEqual({ reopened: true })
    expect(stop.identity).not.toHaveBeenCalled()
  })

  it('shares one stop between concurrent clicks', async () => {
    stop.identity.mockResolvedValueOnce('match').mockResolvedValueOnce('mismatch')
    const [first, second] = await Promise.all([
      reopenNewerDaemonTerminals(),
      reopenNewerDaemonTerminals()
    ])
    expect(first).toEqual({ reopened: true })
    expect(second).toEqual({ reopened: true })
    expect(stop.kill).toHaveBeenCalledTimes(1)
  })
})
