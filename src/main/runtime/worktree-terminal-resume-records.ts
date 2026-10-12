// A workspace close's last step: its sleeping-agent resume records and pane incarnations go too.

import type { ExecutionHostId } from '../../shared/execution-host'
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
 * The holder's close took each closed pane's records; it still carries the ones no loaded pane
 * names, which main's close cleared with the rest.
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
