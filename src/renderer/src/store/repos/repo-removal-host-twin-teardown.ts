import type { AppState } from '../types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  isRemoteRuntimePtyId,
  parseRemoteRuntimePtyId
} from '../../../../shared/remote-runtime-pty-id'
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

/**
 * State under a worktree id that a surviving host also publishes, attributed to the removed host.
 * Anything without host evidence stays: it may be the survivor's.
 */
export type RemovedHostTwinState = {
  terminalTabIds: Set<string>
  fileIds: Set<string>
  browserTabIds: Set<string>
  /** Unified tab ids of the removed host's structured chats. */
  agentSessionTabIds: Set<string>
  /** Their conversation ids, which key the chats' drafts. */
  conversationIds: Set<string>
}

type HostEvidence = ExecutionHostId | 'non-runtime' | null

function isRuntimeHost(hostId: ExecutionHostId): boolean {
  return parseExecutionHostId(hostId)?.kind === 'runtime'
}

function ptyHostEvidence(ptyId: string): HostEvidence {
  if (!isRemoteRuntimePtyId(ptyId)) {
    // Why: a runtime host's PTYs are always `remote:` ids, so this one runs on a local/SSH host.
    return 'non-runtime'
  }
  const environmentId = parseRemoteRuntimePtyId(ptyId)?.environmentId
  return environmentId ? toRuntimeExecutionHostId(environmentId) : null
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
  state: Pick<AppState, 'tabsByWorktree' | 'unifiedTabsByWorktree' | 'ptyIdsByTabId' | 'openFiles'>,
  twinWorktreeIds: ReadonlySet<string>,
  removedHostId: ExecutionHostId,
  survivingHostIdsByWorktreeId: ReadonlyMap<string, readonly ExecutionHostId[]>
): RemovedHostTwinState {
  const removed: RemovedHostTwinState = {
    terminalTabIds: new Set(),
    fileIds: new Set(),
    browserTabIds: new Set(),
    agentSessionTabIds: new Set(),
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
      const ptyIds = [...(state.ptyIdsByTabId[tab.id] ?? []), ...(tab.ptyId ? [tab.ptyId] : [])]
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
    for (const tab of unifiedTabs) {
      if (tab.executionHostId !== removedHostId) {
        continue
      }
      if (tab.contentType === 'terminal') {
        // Why: a hydrated terminal can exist only as a unified tab, with no legacy row above.
        removed.terminalTabIds.add(tab.entityId)
      } else if (tab.contentType === 'browser') {
        removed.browserTabIds.add(tab.entityId)
      } else if (tab.contentType === 'agent-session') {
        removed.agentSessionTabIds.add(tab.id)
        removed.conversationIds.add(tab.entityId)
      }
    }
  }
  return removed
}

/** Union of two attributions: one taken before the host call, one after it settled. */
export function mergeRemovedHostTwinState(
  a: RemovedHostTwinState,
  b: RemovedHostTwinState
): RemovedHostTwinState {
  return {
    terminalTabIds: new Set([...a.terminalTabIds, ...b.terminalTabIds]),
    fileIds: new Set([...a.fileIds, ...b.fileIds]),
    browserTabIds: new Set([...a.browserTabIds, ...b.browserTabIds]),
    agentSessionTabIds: new Set([...a.agentSessionTabIds, ...b.agentSessionTabIds]),
    conversationIds: new Set([...a.conversationIds, ...b.conversationIds])
  }
}

/** Closes only the removed host's twin state; the survivor's tabs, files and drafts stay. */
export function closeRemovedHostTwinState(
  get: () => AppState,
  removed: RemovedHostTwinState,
  removedHostId: ExecutionHostId
): void {
  // Why: a runtime host stopped its own shells on removal, so no close is sent back to it.
  const remoteCloseOwnedByHost = isRuntimeHost(removedHostId)
  for (const tabId of removed.terminalTabIds) {
    get().closeTab(tabId, {
      reason: 'cleanup',
      captureRecentlyClosed: false,
      remoteCloseOwnedByHost
    })
  }
  for (const fileId of removed.fileIds) {
    get().closeFile(fileId)
  }
  for (const browserTabId of removed.browserTabIds) {
    get().closeBrowserTab(browserTabId, { reason: 'cleanup' })
  }
  for (const tabId of removed.agentSessionTabIds) {
    get().closeUnifiedTab(tabId, { preserveWorktreeSelection: true })
  }
}
