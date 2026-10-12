import { projectHostSessionTabSource } from '../../../shared/host-session-snapshot'
import { parseExecutionHostId, toSshExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { resolveExplicitWorktreeOperationRouteResult } from '../lib/worktree-operation-catalog-route'
import { resolveStrictWorktreeOperationRouteResultForHost } from '../lib/worktree-operation-route'
import type {
  WorktreeOperationRouteResolution,
  WorktreeOperationRouteState
} from '../lib/worktree-operation-route'
import { getExplicitRuntimeEnvironmentIdForFolderWorkspace } from '../lib/folder-workspace-runtime-owner'
import {
  findIndexedFolderWorkspaceOwner,
  findIndexedProjectGroupOwner
} from '../lib/worktree-runtime-owner-index'
import { routeForOwner } from '../lib/worktree-owner-route'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import {
  localStructuredSessionGeneration,
  localStructuredSessionVersionByWorktree,
  localStructuredSessionEpochHistoryByWorktree
} from './local-structured-session-tabs-sync/inventory-generation-fence'
import { projectLocalStructuredSessionTabs } from './local-structured-session-tabs-sync/snapshot-projection'
import { LOCAL_STRUCTURED_SESSION_OWNER } from './local-structured-session-owner'
import { suppressCancelledStructuredSessionTabs } from './structured-agent-session-tab-retirement'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { applyWebSessionTabsStorePatch } from './web-session-tabs-sync/store-patch'
import {
  latestSessionTabsSnapshotByWorktree,
  sessionTabsRemovalWatermarkByWorktree
} from './web-session-tabs-sync/state'
import { sessionTabsFreshnessKey } from './web-session-tabs-sync/tracking'
import {
  isCurrentSessionTabsRuntimeFrame,
  isRetiredSessionTabsPublicationEpoch,
  sameSessionTabsPublicationLineage
} from './web-session-tabs-sync/publisher-identity-fences'
import { survivingHostSessionTabClosePlacement } from './host-session-tab-close-placement'
import type { WebSessionCloseIntentTicket } from './web-session-close-intent'
import { resolveLocalTabIdForHostSessionTab } from './web-session-tabs-sync/tracking-mappings'

function resolveSourceWorkspaceOwner(
  state: WorktreeOperationRouteState,
  worktreeId: string
): WorktreeOperationRouteResolution {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type !== 'folder') {
    return resolveExplicitWorktreeOperationRouteResult(state, worktreeId)
  }
  const folder = findIndexedFolderWorkspaceOwner(state.folderWorkspaces, scope.folderWorkspaceId)
  if (!folder) {
    return state.folderWorkspaces?.some((row) => row.id === scope.folderWorkspaceId)
      ? { kind: 'ambiguous' }
      : { kind: 'missing' }
  }
  const group = findIndexedProjectGroupOwner(state.projectGroups, folder.projectGroupId)
  if (!group && state.projectGroups?.some((row) => row.id === folder.projectGroupId)) {
    return { kind: 'ambiguous' }
  }
  const host = parseExecutionHostId(folder.executionHostId ?? group?.executionHostId)
  const connectionId = folder.connectionId?.trim() || group?.connectionId?.trim()
  const route = routeForOwner({
    hostId: host?.id ?? (connectionId ? toSshExecutionHostId(connectionId) : undefined),
    runtimeOwnerEnvironmentId:
      getExplicitRuntimeEnvironmentIdForFolderWorkspace(state, scope.folderWorkspaceId) ?? undefined
  })
  return route ? { kind: 'resolved', route } : { kind: 'missing' }
}

export function reprojectHostSessionTabSource(ticket: WebSessionCloseIntentTicket): void {
  const { owner, worktreeId } = ticket
  const local = owner.environmentId === LOCAL_STRUCTURED_SESSION_OWNER
  const accepted = local
    ? localStructuredSessionVersionByWorktree.get(worktreeId)
    : latestSessionTabsSnapshotByWorktree.get(
        sessionTabsFreshnessKey(owner.environmentId, worktreeId)
      )
  if (!accepted?.source) {
    return
  }
  const source = accepted.source
  if (local) {
    const current = localStructuredSessionVersionByWorktree.get(worktreeId)
    if (
      current?.generation !== ticket.localGeneration ||
      ticket.localGeneration !== localStructuredSessionGeneration()
    ) {
      return
    }
    if (
      localStructuredSessionEpochHistoryByWorktree
        .get(worktreeId)
        ?.retired.some((epoch) => sameSessionTabsPublicationLineage(epoch, source.publicationEpoch))
    ) {
      return
    }
  } else {
    const current = latestSessionTabsSnapshotByWorktree.get(
      sessionTabsFreshnessKey(owner.environmentId, worktreeId)
    )
    if (
      !current ||
      current.pairingRevision !== owner.pairingRevision ||
      getRuntimeEnvironmentRevision(owner.environmentId) !== owner.pairingRevision
    ) {
      return
    }
    const key = sessionTabsFreshnessKey(owner.environmentId, worktreeId)
    if (
      !isCurrentSessionTabsRuntimeFrame(owner.environmentId, current.sourceRuntimeId) ||
      isRetiredSessionTabsPublicationEpoch(key, source.publicationEpoch) ||
      (sessionTabsRemovalWatermarkByWorktree.get(key) ?? 0) > (current.sourceReceivedFrame ?? 0)
    ) {
      return
    }
  }
  const snapshot = local
    ? projectLocalStructuredSessionTabs(
        suppressCancelledStructuredSessionTabs(source, { kind: 'local' })
      )
    : source
  const projection = projectHostSessionTabSource(snapshot)
  applyWebSessionTabsStorePatch(
    (state) => {
      const catalog = resolveSourceWorkspaceOwner(state, worktreeId)
      const host =
        state.activeWorktreeId === worktreeId
          ? parseExecutionHostId(state.activeWorkspaceExecutionHostId)
          : null
      const selected = host
        ? catalog.kind === 'resolved' && catalog.route.executionHostId === host.id
          ? catalog
          : resolveStrictWorktreeOperationRouteResultForHost(state, worktreeId, host.id)
        : ({ kind: 'missing' } as const)
      // A catalog gap is silence; the captured pairing/generation remains the recovery fence.
      if (
        [catalog, selected].some(
          (resolution) =>
            resolution.kind === 'ambiguous' ||
            (resolution.kind === 'resolved' &&
              (local
                ? resolution.route.executionHostId !== 'local' ||
                  resolution.route.runtimeEnvironmentId !== null
                : resolution.route.runtimeEnvironmentId !== owner.environmentId))
        )
      ) {
        return state
      }
      const currentTabId = resolveLocalTabIdForHostSessionTab({
        environmentId: owner.environmentId,
        worktreeId,
        hostTabId: ticket.closedId
      })
      const placement = state.unifiedTabsByWorktree[worktreeId]?.some(
        (tab) => tab.id === currentTabId
      )
        ? undefined
        : survivingHostSessionTabClosePlacement(state, worktreeId, ticket.placement)
      const closeRestoration = placement ? { ...placement, hostTabId: ticket.closedId } : undefined
      return applyWebSessionTabsSnapshot(state, projection, owner.environmentId, Date.now(), {
        projectionOnly: true,
        closeRestoration,
        ...(local
          ? ({
              contentScope: 'agent-session',
              preserveLocalLayout: true,
              terminalPtyMode: 'local'
            } as const)
          : {})
      })
    },
    { frames: [] }
  )()
}
