import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationManifestSource
} from '../../../shared/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { OrcadMigrationTerminalScrollbackSnapshot } from '../../../shared/orcad-migration-scrollback'
import {
  extractSessionOwnersForTransfer,
  hasTransferredSessionState
} from '../../orca-profiles/profile-session-owner-transfer'
import type { TerminalScrollbackSnapshotStorage } from '../../terminal-scrollback-snapshots'
import {
  createOrcadMigrationSourceScope,
  orcadMigrationOwnerMatchesScope,
  orcadMigrationPartitionScope,
  unqualifyOrcadMigrationOwnerKey
} from './orcad-source-scope'
import {
  collectUnsupportedSessionItems,
  projectDormantSessionFocus,
  projectSessionToDestination,
  transferableSleepingAgentSession,
  worktreeLabel
} from './orcad-source-workspace-session-eligibility'
import { withoutLeftBehindSessionRows } from './orcad-source-left-behind-session-rows'
import {
  collectOwnedTerminalTabIds,
  dropOrcadMigrationTerminalBindings
} from './orcad-source-workspace-session-layout'
import { mergeSessionFragments } from './orcad-source-workspace-session-fragments'
import { hasClosedTerminalTabRecord } from '../../../shared/closed-terminal-tab-tombstones'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../../shared/workspace-scope'
import { withoutWorkspaces } from '../../../shared/workspace-session-stranded-partition-adoption'
import { orcadMigrationSessionPartitions } from './orcad-source-session-partitions'
import {
  hasDuplicateOrcadMigrationScrollbackDescriptors,
  projectOrcadMigrationSessionScrollback
} from './orcad-source-scrollback-state'

export type OrcadMigrationSourceWorkspaceSessionInspection = {
  payload: WorkspaceSessionState | undefined
  snapshots: OrcadMigrationTerminalScrollbackSnapshot[]
  /** Each names what blocks and how to clear it. */
  blockedItems: string[]
  /** What a confirmed "Move anyway" leaves in this desktop's retained profile. */
  leftBehindItems: string[]
}

const UNREADABLE_SESSION = 'saved tabs Orca could not read'

/** Fails closed: a session shape no collector expects blocks the move instead of failing connect. */
export function collectOrcadMigrationSourceWorkspaceSession(
  state: PersistedState,
  source: OrcadMigrationManifestSource,
  catalog: OrcadMigrationCatalogPayload,
  storage?: TerminalScrollbackSnapshotStorage,
  leaveBehind = false
): OrcadMigrationSourceWorkspaceSessionInspection {
  let collected: OrcadMigrationSourceWorkspaceSessionInspection
  try {
    collected = collectWorkspaceSession(state, source, catalog, storage, leaveBehind)
  } catch (error) {
    console.warn('[migration] Unreadable workspace session blocks the move:', error)
    collected = {
      payload: undefined,
      snapshots: [],
      blockedItems: [UNREADABLE_SESSION],
      leftBehindItems: []
    }
  }
  // "Move anyway": what still can't move leaves the whole saved session on this desktop.
  return leaveBehind && collected.blockedItems.length > 0
    ? {
        payload: undefined,
        snapshots: [],
        blockedItems: [],
        leftBehindItems: [...collected.leftBehindItems, ...collected.blockedItems]
      }
    : collected
}

function collectWorkspaceSession(
  state: PersistedState,
  source: OrcadMigrationManifestSource,
  catalog: OrcadMigrationCatalogPayload,
  storage: TerminalScrollbackSnapshotStorage | undefined,
  leaveBehind: boolean
): OrcadMigrationSourceWorkspaceSessionInspection {
  const sourceScope = createOrcadMigrationSourceScope({ source, catalog, repos: state.repos })
  const fragments: WorkspaceSessionState[] = []
  const localFragments = new Set<WorkspaceSessionState>()
  const snapshots: OrcadMigrationTerminalScrollbackSnapshot[] = []
  const blockedItems: string[] = []
  const leftBehindItems: string[] = []
  const partitions = orcadMigrationSessionPartitions(state, sourceScope).map(
    ([partitionId, saved]) => {
      const scope = orcadMigrationPartitionScope(sourceScope, partitionId)
      const session = withoutLeftBehindSessionRows(saved, scope, leaveBehind)
      return {
        saved,
        session,
        scope,
        terminalTabIds: collectOwnedTerminalTabIds(session, scope)
      }
    }
  )
  const sourceTerminalTabIds = new Set(
    partitions.flatMap(({ terminalTabIds }) => [...terminalTabIds])
  )
  for (const { saved, session, scope, terminalTabIds } of partitions) {
    const sourceHostPartition = scope.partitionHostId === scope.hostId
    // Left behind, these are rows the export already drops or never extracts.
    ;(leaveBehind ? leftBehindItems : blockedItems).push(
      ...collectUnsupportedSessionItems(
        // The rows as saved, so what stays behind is still named.
        leaveBehind ? withoutLeftBehindSessionRows(saved, scope) : session,
        scope,
        sourceHostPartition,
        terminalTabIds,
        sourceTerminalTabIds
      )
    )
    const fragment = extractSessionOwnersForTransfer(session, {
      mapOwnerKey: (ownerKey) =>
        orcadMigrationOwnerMatchesScope(ownerKey, scope)
          ? unqualifyOrcadMigrationOwnerKey(ownerKey)
          : null,
      mapWorktreeId: unqualifyOrcadMigrationOwnerKey,
      projectSessionFocus: sourceHostPartition
        ? ({ source, transferred, terminalTabIds }) =>
            projectDormantSessionFocus(source, transferred, scope, terminalTabIds)
        : undefined,
      projectSleepingAgentSession: (record) =>
        transferableSleepingAgentSession(record, session, scope, terminalTabIds)
          ? {
              ...structuredClone(record),
              worktreeId: unqualifyOrcadMigrationOwnerKey(record.worktreeId),
              connectionId: null
            }
          : null
    })
    if (!sourceHostPartition) {
      // Client focus is not host state, so the destination never carries it.
      fragment.activeWorktreeId = null
      delete fragment.activeWorkspaceKey
    }
    dropOrcadMigrationTerminalBindings(fragment)
    if (hasTransferredSessionState(fragment)) {
      const projected = projectOrcadMigrationSessionScrollback(
        projectSessionToDestination(fragment, scope),
        storage
      )
      blockedItems.push(...projected.blockedItems)
      snapshots.push(...projected.snapshots)
      fragments.push(projected.session)
      if (scope.partitionHostId === LOCAL_EXECUTION_HOST_ID) {
        localFragments.add(projected.session)
      }
    }
  }
  if (hasDuplicateOrcadMigrationScrollbackDescriptors(snapshots)) {
    blockedItems.push('terminal history saved twice for one pane')
  }
  if (blockedItems.length > 0 || fragments.length === 0) {
    return { payload: undefined, snapshots: [], blockedItems, leftBehindItems }
  }
  const closedTabIds = new Set(
    partitions.flatMap(({ session }) =>
      Object.keys(session.closedTerminalTabTombstonesByTabId ?? {}).filter((tabId) =>
        hasClosedTerminalTabRecord(session.closedTerminalTabTombstonesByTabId, tabId)
      )
    )
  )
  let merged = mergeSessionFragments(fragments, closedTabIds)
  if (!merged.session && leaveBehind) {
    // "Move anyway": the host's copy moves, as the app reads it; the desktop's stays behind.
    const conflicting = new Set(merged.conflicts.map(normalizeWorkspaceSessionKeyToWorkspaceId))
    leftBehindItems.push(
      ...merged.conflicts.map(
        (ownerKey) => `this desktop's older copy of the tabs in ${worktreeLabel(ownerKey)}`
      )
    )
    merged = mergeSessionFragments(
      fragments.map((fragment) =>
        localFragments.has(fragment) ? withoutWorkspaces(fragment, conflicting) : fragment
      ),
      closedTabIds
    )
  }
  return merged.session
    ? { payload: merged.session, snapshots, blockedItems: [], leftBehindItems }
    : {
        payload: undefined,
        snapshots: [],
        blockedItems: merged.conflicts.map(
          (ownerKey) => `two different saved copies of the tabs in ${worktreeLabel(ownerKey)}`
        ),
        leftBehindItems
      }
}
