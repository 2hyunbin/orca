import { useAppStore } from '@/store'
import { nativeChatNewDrafts, retireNativeChatNewDraft } from '@/components/native-chat/native-chat-new-draft'
import { deleteNativeChatComposerDraft } from '@/components/native-chat/native-chat-composer-draft-store'
import type { NativeChatNewDraft } from '@/components/native-chat/native-chat-composer-draft-storage'
import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { fetchFolderWorkspaceCatalogForTarget, getFolderWorkspaceHostId } from '@/store/folder-workspaces/folder-workspace-catalog'
import { catalogOwnsHost } from '@/store/slices/project-group-owner-routing'
import { openStructuredAgentSessionProvisionalTab } from './structured-agent-session-provisional-tab'
import { getStructuredLaunchStateBySessionId } from './structured-agent-session-launch-registry'
import { deleteStructuredAgentLaunchRecord } from './structured-agent-session-launch-persistence'
import { markStructuredAgentSessionLaunchPublished } from './structured-agent-session-launch-publication'
import { readStructuredSessionTabInventory } from '@/runtime/structured-session-tab-inventory'

async function ownerConfirmedGone(draft: NativeChatNewDraft): Promise<boolean> {
  const { workspaceId, executionHostId } = draft.owner
  const state = useAppStore.getState()
  const host = parseExecutionHostId(executionHostId)
  if (host?.kind === 'runtime' && state.runtimeEnvironmentCatalogHydrated &&
    !state.runtimeEnvironments.some((environment) => environment.id === host.environmentId)) {
    return true
  }
  if (findKnownWorktreeById(state, workspaceId, executionHostId)) {
    return false
  }
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    const target = structuredAgentSessionTargetForHost(executionHostId)
    if (!target) {
      return false
    }
    const catalog = await fetchFolderWorkspaceCatalogForTarget(target, state.projectGroups)
    return catalogOwnsHost(catalog.hostId, executionHostId) && !catalog.folderWorkspaces.some((row) =>
      row.id === scope.folderWorkspaceId && getFolderWorkspaceHostId(row, state.projectGroups) === executionHostId)
  }
  const authoritative = await state.fetchWorktrees(getRepoIdFromWorktreeId(workspaceId), {
    executionHostId, requireAuthoritative: true
  })
  return authoritative && !findKnownWorktreeById(useAppStore.getState(), workspaceId, executionHostId)
}

export async function reconcileRestoredNativeChatDrafts(): Promise<void> {
  const inventories = new Map<string, ReturnType<typeof readStructuredSessionTabInventory>>()
  for (const [sessionId, draft] of nativeChatNewDrafts()) {
    try {
      if (await ownerConfirmedGone(draft)) {
        if (await retireNativeChatNewDraft(sessionId)) {
          deleteNativeChatComposerDraft(`agent-session:${sessionId}`)
          deleteStructuredAgentLaunchRecord(sessionId)
        }
        continue
      }
      if (!getStructuredLaunchStateBySessionId(sessionId) && (useAppStore.getState().groupsByWorktree[draft.owner.workspaceId] ?? []).some((group) => group.id === draft.groupId)) {
        openStructuredAgentSessionProvisionalTab({
          worktreeId: draft.owner.workspaceId, executionHostId: draft.owner.executionHostId,
          sessionId, agent: draft.agent, targetGroupId: draft.groupId, activate: false
        })
      }
      const hostId = draft.owner.executionHostId
      const target = structuredAgentSessionTargetForHost(hostId)
      if (target && !inventories.has(hostId)) {
        inventories.set(hostId, readStructuredSessionTabInventory(target))
      }
      const inventory = await inventories.get(hostId) ?? []
      if (inventory.some((row) => row.worktree === draft.owner.workspaceId && row.tabs.some((tab) => tab.type === 'agent-session' && tab.sessionId === sessionId))) {
        markStructuredAgentSessionLaunchPublished(draft.owner.workspaceId, sessionId, draft.owner.executionHostId)
      }
    } catch (error) {
      console.warn('[native-chat-drafts] the saved chat owner could not be verified', error)
    }
  }
}
