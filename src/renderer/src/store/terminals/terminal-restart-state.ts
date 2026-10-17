import { isSameCodexStalePaneAccount } from '../slices/codex-stale-pane-account-identity'
import type { AccountRestartAgent } from './terminal-contracts'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'

// Why: Codex stale-pane cleanup shares this map with Claude switch restarts and must not drop them.
function dropQueuedCodexRestart(pending: Record<string, AccountRestartAgent>, ptyId: string): void {
  if (pending[ptyId] === 'codex') {
    delete pending[ptyId]
  }
}

export function createTerminalRestartActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<
  TerminalSlice,
  | 'consumeSuppressedPtyExit'
  | 'isPtyShutdownPending'
  | 'suppressPtyExit'
  | 'queuePaneAccountRestarts'
  | 'consumePendingPaneAccountRestart'
  | 'markCodexStalePanes'
  | 'clearCodexStalePane'
  | 'keepCodexStalePanes'
> {
  return {
    consumeSuppressedPtyExit: (ptyId) => {
      let wasSuppressed = false
      set((s) => {
        if (!s.suppressedPtyExitIds[ptyId]) {
          return s
        }
        wasSuppressed = true
        const next = { ...s.suppressedPtyExitIds }
        delete next[ptyId]
        return { suppressedPtyExitIds: next }
      })
      return wasSuppressed
    },
    isPtyShutdownPending: (ptyId) => (get().pendingPtyShutdownIds[ptyId] ?? 0) > 0,
    suppressPtyExit: (ptyId) => {
      set((s) => ({
        suppressedPtyExitIds: { ...s.suppressedPtyExitIds, [ptyId]: true }
      }))
    },
    queuePaneAccountRestarts: (ptyIds, agent) => {
      if (ptyIds.length === 0) {
        return
      }
      set((s) => ({
        pendingPaneAccountRestarts: {
          ...s.pendingPaneAccountRestarts,
          ...Object.fromEntries(ptyIds.map((ptyId) => [ptyId, agent] as const))
        }
      }))
    },
    consumePendingPaneAccountRestart: (ptyId) => {
      let queuedAgent: AccountRestartAgent | null = null
      set((s) => {
        const agent = s.pendingPaneAccountRestarts[ptyId]
        if (!agent) {
          return s
        }
        queuedAgent = agent
        const next = { ...s.pendingPaneAccountRestarts }
        delete next[ptyId]
        return { pendingPaneAccountRestarts: next }
      })
      return queuedAgent
    },
    markCodexStalePanes: (panes) => {
      if (panes.length === 0) {
        return []
      }
      const owedPtyIds: string[] = []
      set((s) => {
        const next = { ...s.codexStalePaneByPtyId }
        const nextPendingPaneAccountRestarts = { ...s.pendingPaneAccountRestarts }
        for (const pane of panes) {
          const existing = next[pane.ptyId]
          // Why one record rather than two lookups: the label and the id of the
          // launch account have to come from the same source, or they can end up
          // describing two different accounts.
          const launch = existing ?? pane
          const target = { id: pane.nextAccountId, label: pane.nextAccountLabel }
          // Why: a live Codex pane keeps its original launch account until it actually restarts, so A -> B -> A must not ask.
          if (
            isSameCodexStalePaneAccount(
              { id: launch.previousAccountId, label: launch.previousAccountLabel },
              target
            )
          ) {
            delete next[pane.ptyId]
            dropQueuedCodexRestart(nextPendingPaneAccountRestarts, pane.ptyId)
            continue
          }
          // Why: keeping answered "stay on the launch account instead of this one". Adding an
          // account or reauthenticating the active one re-marks with the target unchanged, which
          // must not re-ask; only a genuinely different target does.
          const kept =
            existing?.kept === true &&
            isSameCodexStalePaneAccount(
              { id: existing.nextAccountId, label: existing.nextAccountLabel },
              target
            )
          next[pane.ptyId] = {
            previousAccountLabel: launch.previousAccountLabel,
            nextAccountLabel: pane.nextAccountLabel,
            ...(launch.previousAccountId === undefined
              ? {}
              : { previousAccountId: launch.previousAccountId }),
            ...(pane.nextAccountId === undefined ? {} : { nextAccountId: pane.nextAccountId }),
            ...(kept ? { kept: true as const } : {})
          }
          // Why: a queued restart relaunches under whatever is selected when it runs.
          if (!kept && nextPendingPaneAccountRestarts[pane.ptyId] !== 'codex') {
            owedPtyIds.push(pane.ptyId)
          }
        }
        return {
          codexStalePaneByPtyId: next,
          pendingPaneAccountRestarts: nextPendingPaneAccountRestarts
        }
      })
      return owedPtyIds
    },
    clearCodexStalePane: (ptyId) => {
      set((s) => {
        if (!s.codexStalePaneByPtyId[ptyId]) {
          return s
        }
        const next = { ...s.codexStalePaneByPtyId }
        const nextPendingPaneAccountRestarts = { ...s.pendingPaneAccountRestarts }
        delete next[ptyId]
        dropQueuedCodexRestart(nextPendingPaneAccountRestarts, ptyId)
        return {
          codexStalePaneByPtyId: next,
          pendingPaneAccountRestarts: nextPendingPaneAccountRestarts
        }
      })
    },
    keepCodexStalePanes: (ptyIds) => {
      set((s) => {
        // Why the record stays: `previousAccountLabel` still names the pane's launch account.
        const next = { ...s.codexStalePaneByPtyId }
        const nextPendingPaneAccountRestarts = { ...s.pendingPaneAccountRestarts }
        let changed = false
        for (const ptyId of ptyIds) {
          const pane = next[ptyId]
          if (!pane || pane.kept) {
            continue
          }
          next[ptyId] = { ...pane, kept: true }
          dropQueuedCodexRestart(nextPendingPaneAccountRestarts, ptyId)
          changed = true
        }
        if (!changed) {
          return s
        }
        return {
          codexStalePaneByPtyId: next,
          pendingPaneAccountRestarts: nextPendingPaneAccountRestarts
        }
      })
    }
  }
}
