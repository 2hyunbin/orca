import { hostSessionTabSourceMatchesWorkspaceOwner } from './host-session-tab-source-owner'
import { projectHostSessionTabSource } from '../../../shared/host-session-snapshot'
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
      if (!hostSessionTabSourceMatchesWorkspaceOwner(state, owner, worktreeId)) {
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
