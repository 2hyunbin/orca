import type { Worktree } from '../../../../../shared/worktree/types'
import { applyAgentAttention, resolveAgentAttention } from '@/attention/agent-attention-policy'
import { createTerminalAttentionSurface } from '@/components/terminal-pane/terminal-attention-surface'
import { acknowledgeViewedAutoAckTarget } from '@/hooks/agent-auto-ack-surfaces'
import { isWorkspaceUnread } from './workspace-unread-selector'
import type { AttentionStore, PaneTarget } from './workspace-unread-characterization-fixture'

// Why a driver: each user/system event is replayed here exactly as its production call site
// issues it, so the scenario expectations in the characterization suites never change when a
// call site is rewired — only this file does.

export {
  addLiveTerminalTab,
  createAttentionStore,
  installAttentionMockApi,
  LEAF_1,
  LEAF_2,
  observe,
  WS_A,
  WS_B,
  type AttentionStore,
  type PaneTarget,
  type PersistCall
} from './workspace-unread-characterization-fixture'
export { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'

/** pane-pty-visibility-bind.ts onBell and parked-terminal-byte-watcher.ts onBell. */
export function ringBell(store: AttentionStore, target: PaneTarget): void {
  store.getState().markTerminalBell(target)
}

/** use-notification-dispatch.ts agent-task-complete path; `paneKey: null` is a workspace-only completion. */
export function completeAgentTurn(
  store: AttentionStore,
  target: { worktreeId: string; paneKey: string | null }
): void {
  const state = store.getState()
  const decision = resolveAgentAttention(
    {
      subject: { workspaceId: target.worktreeId, surfaceKey: target.paneKey ?? undefined },
      reason: 'agent-completion',
      settlesTurn: true,
      hasFreshActivityEvidence: true
    },
    createTerminalAttentionSurface(state)
  )
  applyAgentAttention(decision, {
    unread: state.markAgentAttentionUnread,
    requestDelivery: () => {}
  })
}

/** terminal-keydown-fit.ts: a keydown that produces real terminal input. */
export function typeInPane(store: AttentionStore, target: PaneTarget): void {
  store.getState().readTerminalPaneOnInput(target)
}

/** use-terminal-pane-title-effects.ts: pointerdown in a tab; `paneKey` null when no leaf was hit. */
export function pointerDownInTab(
  store: AttentionStore,
  target: { worktreeId: string; tabId: string; paneKey: string | null }
): void {
  store.getState().readTerminalPaneOnInput(target)
}

/** Sidebar quick action and context menu "Mark as read/unread". */
export function toggleUnreadByUser(
  store: AttentionStore,
  row: Pick<Worktree, 'id' | 'hostId' | 'isUnread'>
): void {
  store.getState().setWorkspaceUnreadByUser(row.id, !isWorkspaceUnread(row), row.hostId ?? 'local')
}

/** useAutoAckViewedAgent: the viewed terminal tab's agent is acknowledged. */
export function autoAckViewedTab(store: AttentionStore, target: PaneTarget): void {
  acknowledgeViewedAutoAckTarget(store.getState(), {
    tabId: target.tabId,
    worktreeId: target.worktreeId,
    surfaceKind: 'terminal'
  })
}
