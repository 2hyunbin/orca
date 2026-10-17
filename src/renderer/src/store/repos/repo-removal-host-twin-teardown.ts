import type { AppState } from '../types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { buildTerminalTabRetirementPlans } from '../slices/terminal-tab-retirement'
import { omitSleepingAgentSessionsForWorktrees } from '../slices/worktrees/teardown/sleeping-agent-session-omission'
import type { RecentlyClosedTabKind } from '../slices/recently-closed-tabs'
import { omitRecordKeys } from '../slices/worktrees/teardown/record-key-omission'
import { cancelStructuredLaunchesForWorktrees } from '../slices/worktrees/teardown/worktree-purge-state'
import {
  belongsToRemovedHost,
  collectRemovedHostTwinState,
  isRuntimeHost,
  mergeRemovedHostTwinState,
  openFileHostEvidence,
  pageHostEvidence,
  type HostEvidence,
  type RemovedHostTwinState
} from './repo-removal-host-twin-attribution'

/** Which entries of one reopen stack are the removed host's; unmarked ones may be the survivor's. */
function prunedEntries<T>(stack: readonly T[] | undefined, isRemoved: (entry: T) => boolean) {
  const pruned = (stack ?? []).map(isRemoved)
  return pruned.includes(true) ? pruned : null
}

/** The n-th kind entry of a type is that type's n-th snapshot, so pruned ones go from both. */
function dropPrunedKinds(
  kinds: readonly RecentlyClosedTabKind[],
  kind: RecentlyClosedTabKind,
  pruned: readonly boolean[]
): RecentlyClosedTabKind[] {
  let index = 0
  return kinds.filter((entry) => entry !== kind || !pruned[index++])
}

function pruneRemovedHostReopenHistory(
  state: AppState,
  twinHostIds: ReadonlyMap<string, readonly ExecutionHostId[]>,
  removedHostId: ExecutionHostId
): Partial<AppState> | null {
  const editors = { ...state.recentlyClosedEditorTabsByWorktree }
  const browsers = { ...state.recentlyClosedBrowserTabsByWorktree }
  const kinds = { ...state.recentlyClosedTabKindsByWorktree }
  let changed = false
  for (const [worktreeId, survivors] of twinHostIds) {
    const editorPruned = prunedEntries(editors[worktreeId], (snapshot) =>
      belongsToRemovedHost(openFileHostEvidence(snapshot), removedHostId, survivors)
    )
    const browserPruned = prunedEntries(
      browsers[worktreeId],
      (snapshot) =>
        snapshot.pages.length > 0 &&
        snapshot.pages
          .map(pageHostEvidence)
          .every((evidence) => belongsToRemovedHost(evidence, removedHostId, survivors))
    )
    if (editorPruned) {
      editors[worktreeId] = (editors[worktreeId] ?? []).filter((_, i) => !editorPruned[i])
      kinds[worktreeId] = dropPrunedKinds(kinds[worktreeId] ?? [], 'editor', editorPruned)
    }
    if (browserPruned) {
      browsers[worktreeId] = (browsers[worktreeId] ?? []).filter((_, i) => !browserPruned[i])
      kinds[worktreeId] = dropPrunedKinds(kinds[worktreeId] ?? [], 'browser', browserPruned)
    }
    changed ||= Boolean(editorPruned || browserPruned)
  }
  return changed
    ? {
        recentlyClosedEditorTabsByWorktree: editors,
        recentlyClosedBrowserTabsByWorktree: browsers,
        recentlyClosedTabKindsByWorktree: kinds
      }
    : null
}

/** Sleeping-agent records can outlive their tab, so they are matched by the host they name too. */
function omitRemovedHostSleepingSessions(
  state: AppState,
  twinHostIds: ReadonlyMap<string, readonly ExecutionHostId[]>,
  removedHostId: ExecutionHostId,
  removed: RemovedHostTwinState
): ReturnType<typeof omitSleepingAgentSessionsForWorktrees> {
  const doomedPaneKeys: string[] = []
  for (const [paneKey, record] of Object.entries(state.sleepingAgentSessionsByPaneKey ?? {})) {
    const survivors = twinHostIds.get(record.worktreeId)
    if (!survivors) {
      continue
    }
    const evidence: HostEvidence =
      record.connectionId === undefined
        ? null
        : record.connectionId
          ? toSshExecutionHostId(record.connectionId)
          : 'non-runtime'
    if (
      (record.tabId !== undefined && removed.terminalTabIds.has(record.tabId)) ||
      belongsToRemovedHost(evidence, removedHostId, survivors)
    ) {
      doomedPaneKeys.push(paneKey)
    }
  }
  return omitSleepingAgentSessionsForWorktrees(state, new Set(), doomedPaneKeys)
}

/**
 * Closes only the removed host's twin state; the survivor's tabs, files and drafts stay. Merges
 * the pre-call snapshot, which survives the announcement's refresh, with tabs opened meanwhile.
 */
export function closeRemovedHostTwinState(
  get: () => AppState,
  set: (patch: (state: AppState) => Partial<AppState>) => void,
  twinHostIds: ReadonlyMap<string, readonly ExecutionHostId[]>,
  beforeCall: RemovedHostTwinState,
  removedHostId: ExecutionHostId
): void {
  const twinWorktreeIds = new Set(twinHostIds.keys())
  const removed = mergeRemovedHostTwinState(
    beforeCall,
    collectRemovedHostTwinState(get(), twinWorktreeIds, removedHostId, twinHostIds)
  )
  const sleepingPatch = omitRemovedHostSleepingSessions(get(), twinHostIds, removedHostId, removed)
  if (Object.keys(sleepingPatch).length > 0) {
    set(() => sleepingPatch)
  }
  const historyPatch = pruneRemovedHostReopenHistory(get(), twinHostIds, removedHostId)
  if (historyPatch) {
    set(() => historyPatch)
  }
  // Why: a runtime host stopped its own shells on removal, so no close is sent back to it.
  const remoteCloseOwnedByHost = isRuntimeHost(removedHostId)
  // Why planned together: the planner keeps a PTY another surviving tab still binds.
  const plans = buildTerminalTabRetirementPlans(get(), [...removed.terminalTabIds])
  const retiredPtyIds = new Set<string>()
  for (const [tabId, plan] of plans) {
    for (const ptyId of [
      ...plan.localOrSshPtyIds,
      ...plan.runtimeTerminals.map((terminal) => terminal.ptyId),
      ...plan.cleanupOnlyPtyIds,
      ...plan.unroutablePtyIds
    ]) {
      retiredPtyIds.add(ptyId)
    }
    if (!remoteCloseOwnedByHost) {
      // Why killed here: the shared id resolves to no single host, so the planner marks this
      // host's PTYs unroutable; attribution already proved they are the removed host's.
      for (const ptyId of [...plan.localOrSshPtyIds, ...plan.unroutablePtyIds]) {
        if (!isRemoteRuntimePtyId(ptyId)) {
          window.api.pty.kill(ptyId)
        }
      }
    }
    get().closeTab(tabId, {
      reason: 'cleanup',
      captureRecentlyClosed: false,
      remoteCloseOwnedByHost,
      localPtyTeardownOwnedExternally: !remoteCloseOwnedByHost,
      precomputedRetirementPlan: plan
    })
  }
  // Why: a parked or restored pane has no exit callback left to clear these; shared PTYs are not in the plans' lists.
  set((state) => ({
    suppressedPtyExitIds: omitRecordKeys(state.suppressedPtyExitIds, retiredPtyIds),
    pendingCodexPaneRestartIds: omitRecordKeys(state.pendingCodexPaneRestartIds, retiredPtyIds),
    codexRestartNoticeByPtyId: omitRecordKeys(state.codexRestartNoticeByPtyId, retiredPtyIds)
  }))
  // Why: a pending chat's tab can already be gone, so its launch is cancelled through the registry.
  cancelStructuredLaunchesForWorktrees(new Set(twinHostIds.keys()), removedHostId)
  for (const fileId of removed.fileIds) {
    get().closeFile(fileId, { captureRecentlyClosed: false })
  }
  for (const browserTabId of removed.browserTabIds) {
    get().closeBrowserTab(browserTabId, { reason: 'cleanup' })
  }
  for (const tabId of removed.otherTabIds) {
    get().closeUnifiedTab(tabId, { preserveWorktreeSelection: true })
  }
}
