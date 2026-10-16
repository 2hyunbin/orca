// STA-6224: a user's close the paired host never received must be sent again, not dropped.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import {
  MAX_WEB_SESSION_CLOSE_REPLAY_ATTEMPTS,
  queueWebSessionCloseReplay,
  resetWebSessionCloseReplaysForTests,
  settleWebSessionCloseReplay,
  takeDueWebSessionCloseReplays
} from './web-session-close-replay'
import { recordWebSessionCloseIntent } from './web-session-close-intent'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

const { replayWebSessionTabCloses } = vi.hoisted(() => ({
  replayWebSessionTabCloses: vi.fn(async () => {})
}))

vi.mock('../store', () => ({ useAppStore: { setState: vi.fn() } }))
vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))
vi.mock('./web-runtime-session-tab-lifecycle', () => ({ replayWebSessionTabCloses }))

const OWNER = { environmentId: ENV }
const SURFACE = {
  type: 'terminal' as const,
  id: HOST_SURFACE_ID,
  parentTabId: 'host-tab-1',
  leafId: LEAF_ID,
  title: 'Terminal',
  status: 'ready' as const,
  terminal: 'term_host',
  isActive: true
}

beforeEach(resetWebSessionTabsSyncTestState)
afterEach(() => {
  resetWebSessionCloseReplaysForTests()
  replayWebSessionTabCloses.mockClear()
})

describe('web session close replay', () => {
  it('is due once a snapshot shows the host still holds the tab, and not twice in flight', () => {
    queueWebSessionCloseReplay(OWNER, WT, ['host-tab-1'])

    const [due] = takeDueWebSessionCloseReplays(OWNER, WT, new Set(['host-tab-1']))
    expect(due).toMatchObject({ worktreeId: WT, hostTabIds: ['host-tab-1'], attempts: 1 })
    expect(takeDueWebSessionCloseReplays(OWNER, WT, new Set(['host-tab-1']))).toEqual([])

    expect(settleWebSessionCloseReplay(due!, true)).toBe('done')
    expect(takeDueWebSessionCloseReplays(OWNER, WT, new Set(['host-tab-1']))).toEqual([])
  })

  it('is done without a send when the host no longer lists the tab', () => {
    queueWebSessionCloseReplay(OWNER, WT, ['host-tab-1'])

    expect(takeDueWebSessionCloseReplays(OWNER, WT, new Set())).toEqual([])
    expect(takeDueWebSessionCloseReplays(OWNER, WT, new Set(['host-tab-1']))).toEqual([])
  })

  it('gives up after a bounded number of undelivered sends', () => {
    queueWebSessionCloseReplay(OWNER, WT, ['host-tab-1'])
    const outcomes: string[] = []
    for (let attempt = 0; attempt < MAX_WEB_SESSION_CLOSE_REPLAY_ATTEMPTS; attempt += 1) {
      const [due] = takeDueWebSessionCloseReplays(OWNER, WT, new Set(['host-tab-1']))
      // A repeat failure re-queues the same close; it must not reset the attempt count.
      queueWebSessionCloseReplay(OWNER, WT, ['host-tab-1'])
      outcomes.push(settleWebSessionCloseReplay(due!, false))
    }
    expect(outcomes).toEqual(['retry', 'retry', 'gave-up'])
    expect(takeDueWebSessionCloseReplays(OWNER, WT, new Set(['host-tab-1']))).toEqual([])
  })

  it('never replays a close to a re-paired host', () => {
    queueWebSessionCloseReplay({ environmentId: ENV, pairingRevision: 1 }, WT, ['host-tab-1'])

    expect(
      takeDueWebSessionCloseReplays(
        { environmentId: ENV, pairingRevision: 2 },
        WT,
        new Set(['host-tab-1'])
      )
    ).toEqual([])
  })

  it('sends the held close when a host snapshot arrives, while keeping the tab hidden', async () => {
    recordWebSessionCloseIntent(OWNER, WT, 'host-tab-1', NOW)
    queueWebSessionCloseReplay(OWNER, WT, ['host-tab-1'])

    const patch = applyWebSessionTabsSnapshot(makeState(), makeSnapshot([SURFACE]), ENV, NOW)

    expect((patch.tabsByWorktree?.[WT] ?? []).map((tab) => tab.id)).not.toContain(
      toWebTerminalSurfaceTabId('host-tab-1')
    )
    await vi.waitFor(() => expect(replayWebSessionTabCloses).toHaveBeenCalledOnce())
    expect(replayWebSessionTabCloses).toHaveBeenCalledWith(ENV, [
      expect.objectContaining({ worktreeId: WT, hostTabIds: ['host-tab-1'] })
    ])
  })
})
