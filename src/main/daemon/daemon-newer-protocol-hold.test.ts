import { beforeEach, describe, expect, it, vi } from 'vitest'

const stop = vi.hoisted(() => ({
  classify: vi.fn<(runtimeDir: string, protocolVersion: number) => Promise<string>>(),
  kill: vi.fn<
    (
      runtimeDir: string,
      socketPath: string,
      tokenPath: string,
      protocolVersion: number
    ) => Promise<{ killed: boolean; liveOwnerSurvived: boolean }>
  >(),
  detectColdRestore: vi.fn<(sessionId: string) => Promise<unknown>>()
}))
vi.mock('./daemon-newer-protocol-discovery', () => ({
  classifyNewerProtocolDaemon: stop.classify
}))
vi.mock('./daemon-stale-kill', () => ({ killStaleDaemon: stop.kill }))
vi.mock('./history-reader', () => ({
  HistoryReader: class {
    detectColdRestore(sessionId: string): Promise<unknown> {
      return stop.detectColdRestore(sessionId)
    }
  }
}))
vi.mock('./daemon-launch-paths', () => ({
  getDaemonHistoryDir: () => '/history',
  getDaemonRuntimeDir: () => '/runtime'
}))

import {
  isHoldingForNewerProtocolDaemon,
  readNewerDaemonHold,
  reopenNewerDaemonTerminals,
  setNewerProtocolDaemons
} from './daemon-newer-protocol-hold'
import { PROTOCOL_VERSION } from './types'

const NEWER = PROTOCOL_VERSION + 1

beforeEach(() => {
  vi.clearAllMocks()
  stop.detectColdRestore.mockResolvedValue(null)
  stop.kill.mockResolvedValue({ killed: true, liveOwnerSurvived: false })
  setNewerProtocolDaemons([])
})

describe('readNewerDaemonHold', () => {
  it('holds nothing without a newer daemon, or for stale newer artifacts', async () => {
    await expect(readNewerDaemonHold('s1')).resolves.toEqual({ held: false })
    setNewerProtocolDaemons([{ protocolVersion: NEWER, verdict: 'exited' }])
    expect(isHoldingForNewerProtocolDaemon()).toBe(false)
    await expect(readNewerDaemonHold('s1')).resolves.toEqual({ held: false })
    expect(stop.detectColdRestore).not.toHaveBeenCalled()
  })

  it.each(['live', 'unverifiable'] as const)(
    'returns the saved screen while a newer daemon is %s',
    async (verdict) => {
      setNewerProtocolDaemons([{ protocolVersion: NEWER, verdict }])
      stop.detectColdRestore.mockResolvedValue({
        snapshotAnsi: 'hello',
        scrollbackAnsi: '',
        rehydrateSequences: '',
        cwd: '/w',
        cols: 80,
        rows: 24,
        modes: { alternateScreen: false }
      })
      const hold = await readNewerDaemonHold('s1')
      expect(hold.held && hold.restoredScreen?.scrollback.startsWith('hello')).toBe(true)
    }
  )
})

describe('reopenNewerDaemonTerminals', () => {
  beforeEach(() => setNewerProtocolDaemons([{ protocolVersion: NEWER, verdict: 'live' }]))

  it('releases once the verified daemon is stopped and reclassified exited', async () => {
    stop.classify.mockResolvedValueOnce('live').mockResolvedValueOnce('exited')
    await expect(reopenNewerDaemonTerminals()).resolves.toEqual({ reopened: true })
    expect(stop.kill).toHaveBeenCalledWith(
      '/runtime',
      expect.stringContaining(`v${NEWER}`),
      expect.stringContaining(`daemon-v${NEWER}.token`),
      NEWER
    )
    expect(isHoldingForNewerProtocolDaemon()).toBe(false)
  })

  it('reopens nothing when the daemon survives the stop', async () => {
    stop.classify.mockResolvedValue('live')
    stop.kill.mockResolvedValue({ killed: false, liveOwnerSurvived: true })
    await expect(reopenNewerDaemonTerminals()).resolves.toEqual({ reopened: false })
    expect(isHoldingForNewerProtocolDaemon()).toBe(true)
  })

  it('reopens nothing when a stop reports success but the daemon still reads live', async () => {
    stop.classify.mockResolvedValue('live')
    await expect(reopenNewerDaemonTerminals()).resolves.toEqual({ reopened: false })
    expect(isHoldingForNewerProtocolDaemon()).toBe(true)
  })

  it('never signals an owner it cannot identify', async () => {
    stop.classify.mockResolvedValue('unverifiable')
    await expect(reopenNewerDaemonTerminals()).resolves.toEqual({ reopened: false })
    expect(stop.kill).not.toHaveBeenCalled()
    expect(isHoldingForNewerProtocolDaemon()).toBe(true)
  })

  it('releases a daemon that already reads exited without signalling it', async () => {
    stop.classify.mockResolvedValue('exited')
    await expect(reopenNewerDaemonTerminals()).resolves.toEqual({ reopened: true })
    expect(stop.kill).not.toHaveBeenCalled()
  })

  it('shares one stop between concurrent clicks', async () => {
    stop.classify.mockResolvedValueOnce('live').mockResolvedValueOnce('exited')
    const results = await Promise.all([reopenNewerDaemonTerminals(), reopenNewerDaemonTerminals()])
    expect(results).toEqual([{ reopened: true }, { reopened: true }])
    expect(stop.kill).toHaveBeenCalledTimes(1)
  })
})
