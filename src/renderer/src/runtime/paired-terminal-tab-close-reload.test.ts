// STA-6224: a close the paired host never received must survive a reload, or the host's next
// snapshot brings the closed tab back and the close is never sent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { parseWorkspaceSession } from '../../../shared/workspace-session-schema'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { useAppStore, type AppState } from '@/store'
import {
  createSessionWriteSubscriber,
  type WorkspaceSessionWrite
} from '@/lib/session-write-subscriber'
import {
  holdWebSessionCloseForReplay,
  resetWebSessionCloseReplaysForTests
} from './web-session-close-replay'
import { appPairedTerminalTabCloseIntentStore } from './paired-terminal-tab-close-intent-store'
import { recordReceivedWebSessionTabsSnapshot } from './web-session-tabs-sync/tracking'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
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

vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))
vi.mock('./web-runtime-session-tab-lifecycle', () => ({ replayWebSessionTabCloses }))

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

let initialState: AppState

beforeEach(() => {
  initialState = useAppStore.getState()
  vi.useFakeTimers({ now: NOW })
  resetWebSessionTabsSyncTestState()
  replaceRuntimeEnvironmentRevisions([{ id: ENV, createdAt: 0, pairingRevision: 1 }])
})
afterEach(() => {
  vi.useRealTimers()
  useAppStore.setState(initialState, true)
  resetWebSessionCloseReplaysForTests()
  replaceRuntimeEnvironmentRevisions([])
  replayWebSessionTabCloses.mockClear()
})

function persistHeldClose(): unknown {
  const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
  const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })
  useAppStore.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
  vi.advanceTimersByTime(200)
  persist.mockClear()

  holdWebSessionCloseForReplay(
    appPairedTerminalTabCloseIntentStore,
    { environmentId: ENV, pairingRevision: 1 },
    WT,
    ['host-tab-1']
  )
  vi.advanceTimersByTime(200)
  cleanup()
  expect(persist).toHaveBeenCalledOnce()
  return JSON.parse(
    JSON.stringify({ ...getDefaultWorkspaceSession(), ...persist.mock.calls[0][0].patch })
  )
}

describe('a held paired-host close across a reload', () => {
  it('still hides the tab and is replayed on the first snapshot that lists it', async () => {
    const saved = persistHeldClose()

    // The reload: every in-memory close record is gone, and the store starts from the saved session.
    resetWebSessionTabsSyncTestState()
    resetWebSessionCloseReplaysForTests()
    useAppStore.setState(initialState, true)
    const parsed = parseWorkspaceSession(saved)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      return
    }
    useAppStore.getState().hydrateWorkspaceSession(parsed.value)

    const snapshot = makeSnapshot([SURFACE])
    recordReceivedWebSessionTabsSnapshot(ENV, snapshot)
    const patch = applyWebSessionTabsSnapshot(makeState(), snapshot, ENV, NOW)

    expect((patch.tabsByWorktree?.[WT] ?? []).map((tab) => tab.id)).not.toContain(
      toWebTerminalSurfaceTabId('host-tab-1')
    )
    await vi.waitFor(() => expect(replayWebSessionTabCloses).toHaveBeenCalledOnce())
    expect(replayWebSessionTabCloses).toHaveBeenCalledWith(ENV, [
      expect.objectContaining({
        owner: { environmentId: ENV, pairingRevision: 1 },
        worktreeId: WT,
        hostTabIds: ['host-tab-1']
      })
    ])
  })
})
