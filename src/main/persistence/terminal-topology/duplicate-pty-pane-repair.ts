import type { ExecutionHostId } from '../../../shared/execution-host'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import {
  normalizeTerminalLayoutPtyOwnership,
  resolveTerminalLayoutPtyOwnershipTransfers
} from '../../../shared/terminal-layout-pty-ownership'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'
import { findWorktreeIdForTab } from '../restoring-sessions/pane-identity-migration'
import { writeRestorable } from './restorable-write'
import { keepFrozen, type TerminalTopologyCommitContext } from './terminal-topology-commit'
import { assignWorkspaceSessionPartition } from './terminal-topology-membership'

/** A pane the repair drops, and the pane of the same tab that keeps its terminal. */
export type DuplicatePtyPaneTransfer = {
  worktreeId: string
  tabId: string
  removedLeafId: string
  retainedLeafId: string
  ptyId: string
}

function boundByOtherTab(session: WorkspaceSessionState, tabId: string, ptyId: string): boolean {
  return Object.entries(session.terminalLayoutsByTabId ?? {}).some(
    ([otherTabId, layout]) =>
      otherTabId !== tabId && Object.values(layout?.ptyIdsByLeafId ?? {}).includes(ptyId)
  )
}

/** The partition with one pane per terminal, and the owner transfers that implies; null when none. */
export function planDuplicatePtyPaneRepair(
  session: WorkspaceSessionState
): { session: WorkspaceSessionState; transfers: DuplicatePtyPaneTransfer[] } | null {
  let layouts: Record<string, TerminalLayoutSnapshot> | null = null
  const transfers: DuplicatePtyPaneTransfer[] = []
  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId ?? {})) {
    const repaired = normalizeTerminalLayoutPtyOwnership(layout)
    if (!repaired.changed) {
      continue
    }
    layouts ??= { ...session.terminalLayoutsByTabId }
    layouts[tabId] = repaired.snapshot
    const worktreeId = findWorktreeIdForTab(session, tabId)
    for (const transfer of resolveTerminalLayoutPtyOwnershipTransfers(layout, repaired.snapshot)) {
      // The window's transfer guards: only pane keys that parse, and no terminal another tab binds.
      if (
        worktreeId &&
        !tabId.includes(':') &&
        isTerminalLeafId(transfer.removedLeafId) &&
        isTerminalLeafId(transfer.retainedLeafId) &&
        !boundByOtherTab(session, tabId, transfer.ptyId)
      ) {
        transfers.push({ worktreeId, tabId, ...transfer })
      }
    }
  }
  return layouts ? { session: { ...session, terminalLayoutsByTabId: layouts }, transfers } : null
}

/**
 * Repairs every non-runtime partition holding a terminal in two panes of one tab. Every transfer
 * runs before the write, so disk never drops a pane key whose agent status has not moved yet.
 */
export function repairDuplicatePtyPanesMutation(
  context: TerminalTopologyCommitContext,
  transfer: (move: DuplicatePtyPaneTransfer) => void
): () => DurableProfileStateMutation<number> {
  return () => {
    const plans = context
      .hostIds()
      // A paired server's partition is a display copy; that server repairs its own.
      .filter((hostId) => !hostId.startsWith('runtime:'))
      .flatMap((hostId: ExecutionHostId) => {
        const plan = planDuplicatePtyPaneRepair(context.getSession(hostId))
        return plan ? [{ hostId, ...plan }] : []
      })
    if (plans.length === 0) {
      return { value: 0, persist: false }
    }
    try {
      plans.forEach((plan) => plan.transfers.forEach(transfer))
    } catch (error) {
      // Disk keeps the duplicate, so the next start retries the whole repair.
      console.warn('[persistence] duplicate-terminal pane repair skipped:', error)
      return { value: 0, persist: false }
    }
    const restores = plans.map(({ hostId, session }) =>
      writeRestorable(
        () => context.getSession(hostId),
        (value) => context.markDirty(assignWorkspaceSessionPartition(context.state, hostId, value)),
        keepFrozen(hostId, session, context)
      )
    )
    return { value: plans.length, rollback: () => restores.forEach((restore) => restore()) }
  }
}
