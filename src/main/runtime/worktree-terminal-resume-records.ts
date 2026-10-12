// A workspace close's last step: its sleeping-agent resume records and pane incarnations go too.

import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { cloneWorkspaceSessionState } from '../persistence/restoring-sessions/session-owner-fields'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from '../persistence/restoring-sessions/workspace-session-write-rollback'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeWorkspaceLayouts } from './runtime-workspace-layouts'

/** Drops every resume record of the workspace, and each incarnation of a closed tab's panes. */
function withoutClosedRecords<R extends { worktreeId: string }>(
  records: { sleeping: Record<string, R>; incarnations: Record<string, string> },
  worktreeId: string,
  closedTabIds: readonly string[]
): { sleeping: Record<string, R>; incarnations: Record<string, string> } | null {
  const sleeping = Object.entries(records.sleeping).filter(
    ([, record]) => record.worktreeId !== worktreeId
  )
  const incarnations = Object.entries(records.incarnations).filter(
    ([paneKey]) => !closedTabIds.some((tabId) => paneKey.startsWith(`${tabId}:`))
  )
  if (
    sleeping.length === Object.keys(records.sleeping).length &&
    incarnations.length === Object.keys(records.incarnations).length
  ) {
    return null
  }
  return { sleeping: Object.fromEntries(sleeping), incarnations: Object.fromEntries(incarnations) }
}

/**
 * With no window the holder's close took each closed pane's records; it still carries the ones
 * no loaded pane names, which main's close cleared with the rest.
 */
export async function clearHeldWorktreeResumeRecords(
  holder: RuntimeWorkspaceLayouts,
  store: Pick<RuntimeStore, 'runDurableMutation'> | null | undefined,
  args: { worktreeId: string; hostId: ExecutionHostId; closedTabIds: readonly string[] }
): Promise<void> {
  const carried = holder.beside(args.hostId)?.carried
  const cleared = carried
    ? withoutClosedRecords(
        { sleeping: carried.unplacedSleepingRecords, incarnations: carried.unplacedIncarnations },
        args.worktreeId,
        args.closedTabIds
      )
    : null
  if (!carried || !cleared) {
    return
  }
  holder.updateBeside(args.hostId, {
    carried: {
      ...carried,
      unplacedSleepingRecords: cleared.sleeping,
      unplacedIncarnations: cleared.incarnations
    }
  })
  await store?.runDurableMutation?.(() => ({ value: undefined, persist: 'if-dirty' }))
}

/** A window's close (until PR 6d) leaves the records in the Store; they are cleared there. */
export async function clearStoredWorktreeResumeRecords(
  store: RuntimeStore | null | undefined,
  args: { worktreeId: string; hostId: ExecutionHostId; closedTabIds: readonly string[] }
): Promise<void> {
  const { worktreeId, hostId, closedTabIds } = args
  const getSession = store?.getWorkspaceSession?.bind(store)
  const setSession = store?.setWorkspaceSession?.bind(store)
  if (!getSession || !setSession || !store?.runDurableMutation) {
    throw new Error('workspace_session_unavailable')
  }
  const refusal = await store.runDurableMutation<Error | undefined>(() => {
    const session = cloneWorkspaceSessionState(getSession(hostId))
    const remainingTerminalRows = session.tabsByWorktree[worktreeId] ?? []
    const remainingUnifiedTerminalTabs = (session.unifiedTabs?.[worktreeId] ?? []).filter(
      (tab) => tab.contentType === 'terminal'
    )
    if (remainingTerminalRows.length > 0 || remainingUnifiedTerminalTabs.length > 0) {
      return { value: new Error('terminal_close_incomplete'), persist: false }
    }
    const cleared = withoutClosedRecords(
      {
        sleeping: session.sleepingAgentSessionsByPaneKey ?? {},
        incarnations: session.terminalPtyIncarnationsByPaneKey ?? {}
      },
      worktreeId,
      closedTabIds
    )
    if (!cleared) {
      return { value: undefined, persist: false }
    }
    const next: WorkspaceSessionState = {
      ...session,
      sleepingAgentSessionsByPaneKey: cleared.sleeping,
      terminalPtyIncarnationsByPaneKey: cleared.incarnations
    }
    setSession(next, hostId)
    const staged = cloneWorkspaceSessionState(getSession(hostId))
    return {
      value: undefined,
      rollback: () => {
        const current = getSession(hostId)
        const rolledBack = rollbackWorkspaceSessionAfterFailedAsyncWrite(session, staged, current)
        if (rolledBack !== current) {
          setSession(rolledBack, hostId)
        }
      }
    }
  })
  if (refusal) {
    throw refusal
  }
}
