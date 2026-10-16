import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { sweepUnclaimedCodexPaneRestarts } from './codex-detached-pane-restart'
import { resetCodexDetachedPaneRestartExecutorForTests } from './codex-detached-pane-restart-scheduler'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OLD_PTY = 'wt1@@old'
const NEW_PTY = 'wt1@@new'
const SESSION_ID = '01a006a6-1d07-70a1-bad5-f9110d5845c0'

function seedClaudePane(): void {
  const paneKey = makePaneKey('tab-1', LEAF_ID)
  useAppStore.setState({
    tabsByWorktree: {
      wt1: [
        {
          id: 'tab-1',
          ptyId: OLD_PTY,
          worktreeId: 'wt1',
          title: 'claude',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    ptyIdsByTabId: { 'tab-1': [OLD_PTY] },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: OLD_PTY }
      }
    },
    agentStatusByPaneKey: {
      [paneKey]: {
        paneKey,
        tabId: 'tab-1',
        state: 'done',
        prompt: '',
        updatedAt: 1,
        stateStartedAt: 1,
        stateHistory: [],
        agentType: 'claude',
        providerSession: { key: 'session_id', id: SESSION_ID }
      }
    }
  })
}

describe('detached Claude account-move restart', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  beforeEach(() => {
    resetCodexDetachedPaneRestartExecutorForTests()
    useAppStore.setState(useAppStore.getInitialState(), true)
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: vi.fn().mockResolvedValue({ id: NEW_PTY }),
          kill: vi.fn().mockResolvedValue(undefined)
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    resetCodexDetachedPaneRestartExecutorForTests()
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('respawns an unmounted Claude pane with a resume of its own session', async () => {
    seedClaudePane()
    useAppStore.getState().queueClaudePaneRestarts([OLD_PTY])

    await sweepUnclaimedCodexPaneRestarts()

    const spawnArgs = vi.mocked(window.api.pty.spawn).mock.calls[0]?.[0]
    expect(spawnArgs).toEqual(
      expect.objectContaining({
        launchAgent: 'claude',
        startupCommandDelivery: 'shell-ready',
        replacesPtyId: OLD_PTY,
        leafId: LEAF_ID
      })
    )
    expect(spawnArgs?.command).toMatch(new RegExp(`^claude .*'--resume' '${SESSION_ID}'$`))
    const state = useAppStore.getState()
    expect(state.pendingPaneAccountRestarts).toEqual({})
    expect(state.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId).toEqual({ [LEAF_ID]: NEW_PTY })
  })
})
