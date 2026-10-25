// One workspace can hold mirrored rows from several paired runtimes at once — an SSH host's server
// for its terminals and another desktop's app for a browser tab it hosts there (#31983). A
// runtime's frame speaks only for the rows that runtime owns; rows owned by another live runtime
// are left for that runtime's own frames to keep or retire.

import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Tab } from '../../../../shared/tab-types'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { getRemoteRuntimePtyEnvironmentId } from '../runtime-terminal-stream'
import { mirroredRuntimeEnvironmentIdForWorkspace } from './mirrored-workspace-owner'
import type { WebSessionTabsSyncState } from './state'
import { environmentIdsMirroringLocalTab } from './tracking-mappings'

/**
 * The sync state is the app store at runtime; these optional reads stay absent in minimal
 * assemblies, which then fall back to treating every row as the publishing runtime's own.
 */
export type MirrorRowOwnershipState = WebSessionTabsSyncState &
  Partial<
    Pick<
      AppState,
      | 'removedRuntimeEnvironmentIds'
      | 'runtimeEnvironments'
      | 'runtimeEnvironmentCatalogSettled'
      | 'repos'
      | 'worktreesByRepo'
      | 'detectedWorktreesByRepo'
      | 'folderWorkspaces'
      | 'projectGroups'
      | 'settings'
    >
  >

/** A runtime that can still publish: not removed, and listed once the catalog has settled. */
function isLiveEnvironment(state: MirrorRowOwnershipState, environmentId: string): boolean {
  if (state.removedRuntimeEnvironmentIds?.has(environmentId)) {
    return false
  }
  if (state.runtimeEnvironmentCatalogSettled !== true || !state.runtimeEnvironments) {
    return true
  }
  return state.runtimeEnvironments.some((environment) => environment.id === environmentId)
}

/** Whether evidence names only other live runtimes; no live evidence leaves the row to this frame. */
function ownedByAnotherLiveEnvironment(
  state: MirrorRowOwnershipState,
  environmentId: string,
  owners: Iterable<string>
): boolean | null {
  const live = [...owners].filter((owner) => isLiveEnvironment(state, owner))
  return live.length === 0 ? null : !live.includes(environmentId)
}

/**
 * Pane bindings name a mirrored terminal's runtime; a mirror still awaiting its first handle is
 * known by the frames that last published it, and failing those by the workspace's own server.
 */
export function isMirroredTerminalOfAnotherEnvironment(
  state: MirrorRowOwnershipState,
  tab: TerminalTab,
  environmentId: string
): boolean {
  const bindingOwners = [
    tab.ptyId,
    ...Object.values(state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {})
  ]
    .map((ptyId) => (ptyId ? getRemoteRuntimePtyEnvironmentId(ptyId) : null))
    .filter((owner): owner is string => owner !== null)
  const verdict =
    ownedByAnotherLiveEnvironment(state, environmentId, bindingOwners) ??
    ownedByAnotherLiveEnvironment(
      state,
      environmentId,
      environmentIdsMirroringLocalTab(tab.worktreeId, tab.id)
    )
  if (verdict !== null) {
    return verdict
  }
  const workspaceOwner = mirroredRuntimeEnvironmentIdForWorkspace(state, tab.worktreeId)
  return workspaceOwner
    ? (ownedByAnotherLiveEnvironment(state, environmentId, [workspaceOwner]) ?? false)
    : false
}

/** A chat names its host; only a live paired runtime other than the publisher keeps it. */
export function isAgentSessionTabOfAnotherHost(
  state: MirrorRowOwnershipState,
  tab: Pick<Tab, 'executionHostId'>,
  publisherExecutionHostId: string
): boolean {
  if (!tab.executionHostId || tab.executionHostId === publisherExecutionHostId) {
    return false
  }
  const host = parseExecutionHostId(tab.executionHostId)
  return host?.kind !== 'runtime' || isLiveEnvironment(state, host.environmentId)
}
