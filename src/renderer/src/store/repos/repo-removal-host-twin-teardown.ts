import type { AppState } from '../types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { getPtyExecutionHost } from '../../../../shared/terminal-execution-host'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import {
  buildTerminalTabRetirementPlans,
  collectPtyIdsForTab
} from '../slices/terminal-tab-retirement'
import { toVisibleTabType } from '../../../../shared/tab-types'
import type { RecentlyClosedTabKind } from '../slices/recently-closed-tabs'
import {
  getOpenFileExecutionHostId,
  hasOpenFileExecutionHostEvidence
} from '@/lib/unified-tab-host-ownership'

/** Worktree ids of this host's project that another host also publishes, with those hosts. */
export function getSurvivingTwinHostIds(
  state: Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo'>,
  projectId: string,
  hostId: ExecutionHostId
): Map<string, ExecutionHostId[]> {
  const rows = [
    ...(state.worktreesByRepo[projectId] ?? []),
    ...(state.detectedWorktreesByRepo[projectId]?.worktrees ?? [])
  ]
  const hostOf = (row: { hostId?: ExecutionHostId }): ExecutionHostId =>
    row.hostId ?? LOCAL_EXECUTION_HOST_ID
  const removedIds = new Set(rows.filter((row) => hostOf(row) === hostId).map((row) => row.id))
  const survivors = new Map<string, ExecutionHostId[]>()
  for (const row of rows) {
    const survivorHostId = hostOf(row)
    if (!removedIds.has(row.id) || survivorHostId === hostId) {
      continue
    }
    const hosts = survivors.get(row.id) ?? []
    if (!hosts.includes(survivorHostId)) {
      survivors.set(row.id, [...hosts, survivorHostId])
    }
  }
  return survivors
}

/** The twins whose surviving host still holds a row now, after the removal's host call. */
export function retainSurvivingTwinHostIds(
  state: Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo'>,
  projectId: string,
  twins: ReadonlyMap<string, readonly ExecutionHostId[]>
): Map<string, ExecutionHostId[]> {
  const rows = [
    ...(state.worktreesByRepo[projectId] ?? []),
    ...(state.detectedWorktreesByRepo[projectId]?.worktrees ?? [])
  ]
  const retained = new Map<string, ExecutionHostId[]>()
  for (const [worktreeId, hostIds] of twins) {
    const live = hostIds.filter((hostId) =>
      rows.some(
        (row) => row.id === worktreeId && (row.hostId ?? LOCAL_EXECUTION_HOST_ID) === hostId
      )
    )
    if (live.length > 0) {
      retained.set(worktreeId, live)
    }
  }
  return retained
}

/**
 * Every id the removal covers, and those it may purge outright. State under an id another host
 * still publishes is shared, so there only the removed host's attributed tabs and files go.
 */
export function splitRemovedWorktreeIds(
  knownIds: readonly string[],
  twinsBeforeCall: ReadonlyMap<string, unknown>,
  twinsNow: ReadonlyMap<string, unknown>
): { worktreeIds: string[]; exclusiveWorktreeIds: string[] } {
  const worktreeIds = [
    ...new Set([...knownIds, ...[...twinsBeforeCall.keys()].filter((id) => !twinsNow.has(id))])
  ]
  return { worktreeIds, exclusiveWorktreeIds: worktreeIds.filter((id) => !twinsNow.has(id)) }
}

/**
 * State under a worktree id that a surviving host also publishes, attributed to the removed host.
 * Anything without host evidence stays: it may be the survivor's.
 */
export type RemovedHostTwinState = {
  terminalTabIds: Set<string>
  fileIds: Set<string>
  browserTabIds: Set<string>
  /** Unified tab ids of the removed host's chats, simulators and other non-file surfaces. */
  otherTabIds: Set<string>
  /** Their conversation ids, which key the chats' drafts. */
  conversationIds: Set<string>
}

type HostEvidence = ExecutionHostId | 'non-runtime' | null

function isRuntimeHost(hostId: ExecutionHostId): boolean {
  return parseExecutionHostId(hostId)?.kind === 'runtime'
}

function ptyHostEvidence(ptyId: string): HostEvidence {
  const host = getPtyExecutionHost(ptyId)
  if (host === 'foreign') {
    return null
  }
  // Why: SSH and runtime PTY ids name their host, so an unprefixed one runs on a local/SSH host.
  return host ?? 'non-runtime'
}

/** A browser page's host: null is explicitly this client, absent is unknown. */
function pageHostEvidence(page: { browserRuntimeEnvironmentId?: string | null }): HostEvidence {
  if (page.browserRuntimeEnvironmentId === null) {
    return 'non-runtime'
  }
  return page.browserRuntimeEnvironmentId
    ? toRuntimeExecutionHostId(page.browserRuntimeEnvironmentId)
    : null
}

function belongsToRemovedHost(
  evidence: HostEvidence,
  removedHostId: ExecutionHostId,
  survivingHostIds: readonly ExecutionHostId[]
): boolean {
  if (evidence === null) {
    return false
  }
  if (evidence !== 'non-runtime') {
    return evidence === removedHostId
  }
  // Non-runtime evidence names one host only when exactly one side is a local/SSH host.
  return !isRuntimeHost(removedHostId) && survivingHostIds.every(isRuntimeHost)
}

export function collectRemovedHostTwinState(
  state: AppState,
  twinWorktreeIds: ReadonlySet<string>,
  removedHostId: ExecutionHostId,
  survivingHostIdsByWorktreeId: ReadonlyMap<string, readonly ExecutionHostId[]>
): RemovedHostTwinState {
  const removed: RemovedHostTwinState = {
    terminalTabIds: new Set(),
    fileIds: new Set(),
    browserTabIds: new Set(),
    otherTabIds: new Set(),
    conversationIds: new Set()
  }
  for (const worktreeId of twinWorktreeIds) {
    const survivors = survivingHostIdsByWorktreeId.get(worktreeId) ?? []
    const owns = (evidence: HostEvidence): boolean =>
      belongsToRemovedHost(evidence, removedHostId, survivors)
    const unifiedTabs = state.unifiedTabsByWorktree[worktreeId] ?? []
    const stampedHostByEntityId = new Map(
      unifiedTabs.flatMap((tab) =>
        tab.executionHostId ? [[tab.entityId, tab.executionHostId] as const] : []
      )
    )
    for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
      const stamped = stampedHostByEntityId.get(tab.id)
      // Why every source: a restored tab can name its host only in its layout or reconnect maps.
      const ptyIds = collectPtyIdsForTab(state, tab.id, tab.ptyId)
      const evidence = stamped ? [stamped] : ptyIds.map(ptyHostEvidence)
      // Why every: one pane on another host means the tab is not only the removed host's.
      if (evidence.length > 0 && evidence.every(owns)) {
        removed.terminalTabIds.add(tab.id)
      }
    }
    for (const file of state.openFiles) {
      if (file.worktreeId !== worktreeId) {
        continue
      }
      const stamped = stampedHostByEntityId.get(file.id)
      const evidence: HostEvidence =
        stamped ??
        (hasOpenFileExecutionHostEvidence(file)
          ? getOpenFileExecutionHostId(file)
          : // Why: runtime files always record their environment, so an unmarked one is local/SSH.
            'non-runtime')
      if (owns(evidence)) {
        removed.fileIds.add(file.id)
      }
    }
    // Why: a browser restored or opened in an inactive twin has no tab stamp, only its pages' host.
    for (const workspace of state.browserTabsByWorktree[worktreeId] ?? []) {
      const pages = state.browserPagesByWorkspace[workspace.id] ?? []
      if (pages.length > 0 && pages.map(pageHostEvidence).every(owns)) {
        removed.browserTabIds.add(workspace.id)
      }
    }
    for (const tab of unifiedTabs) {
      if (tab.executionHostId !== removedHostId) {
        continue
      }
      if (tab.contentType === 'terminal') {
        // Why: a hydrated terminal can exist only as a unified tab, with no legacy row above.
        removed.terminalTabIds.add(tab.entityId)
      } else if (tab.contentType === 'browser') {
        removed.browserTabIds.add(tab.entityId)
      } else if (
        toVisibleTabType(tab.contentType) !== 'editor' ||
        // Why: a stale editor tab with no open file has nothing for the file close to find.
        !state.openFiles.some((file) => file.id === tab.entityId)
      ) {
        removed.otherTabIds.add(tab.id)
        if (tab.contentType === 'agent-session') {
          removed.conversationIds.add(tab.entityId)
        }
      }
    }
  }
  return removed
}

/** Union of two attributions: one taken before the host call, one after it settled. */
function mergeRemovedHostTwinState(
  a: RemovedHostTwinState,
  b: RemovedHostTwinState
): RemovedHostTwinState {
  return {
    terminalTabIds: new Set([...a.terminalTabIds, ...b.terminalTabIds]),
    fileIds: new Set([...a.fileIds, ...b.fileIds]),
    browserTabIds: new Set([...a.browserTabIds, ...b.browserTabIds]),
    otherTabIds: new Set([...a.otherTabIds, ...b.otherTabIds]),
    conversationIds: new Set([...a.conversationIds, ...b.conversationIds])
  }
}

/** Drops the removed host's closed editors from a twin id's reopen stack; the survivor's stay. */
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
    const editorPruned = prunedEntries(
      editors[worktreeId],
      (snapshot) =>
        hasOpenFileExecutionHostEvidence(snapshot) &&
        getOpenFileExecutionHostId(snapshot) === removedHostId
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
  const historyPatch = pruneRemovedHostReopenHistory(get(), twinHostIds, removedHostId)
  if (historyPatch) {
    set(() => historyPatch)
  }
  // Why: a runtime host stopped its own shells on removal, so no close is sent back to it.
  const remoteCloseOwnedByHost = isRuntimeHost(removedHostId)
  // Why planned together: the planner keeps a PTY another surviving tab still binds.
  const plans = buildTerminalTabRetirementPlans(get(), [...removed.terminalTabIds])
  for (const [tabId, plan] of plans) {
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
