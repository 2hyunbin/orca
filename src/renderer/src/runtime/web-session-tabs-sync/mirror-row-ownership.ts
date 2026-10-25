// One workspace can hold mirrored rows from several paired runtimes at once — an SSH host's server
// for its terminals and another desktop's app for a browser tab it hosts there (#31983). A
// runtime's frame speaks only for the rows that runtime owns; rows owned by another live runtime
// are left for that runtime's own frames to keep or retire.

import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { getRemoteRuntimePtyEnvironmentId } from '../runtime-terminal-stream'
import type { WebSessionTabsSyncState } from './state'
import { environmentIdsMirroringLocalTab } from './tracking-mappings'

/**
 * The sync state is the app store at runtime; minimal assemblies omit the catalog, and then every
 * runtime a row names counts as live.
 */
export type MirrorRowOwnershipState = WebSessionTabsSyncState &
  Partial<
    Pick<
      AppState,
      'removedRuntimeEnvironmentIds' | 'runtimeEnvironments' | 'runtimeEnvironmentCatalogSettled'
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

/**
 * Pane bindings and the frames that last published a mirrored terminal name the runtimes it
 * belongs to. While any other live runtime still claims it, this frame may not retire it — a row
 * two runtimes share stays until neither claims it. With no claim at all it is this frame's.
 */
export function isMirroredTerminalOfAnotherEnvironment(
  state: MirrorRowOwnershipState,
  tab: TerminalTab,
  environmentId: string
): boolean {
  const owners = new Set(environmentIdsMirroringLocalTab(tab.worktreeId, tab.id))
  for (const ptyId of [
    tab.ptyId,
    ...Object.values(state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {})
  ]) {
    const owner = ptyId ? getRemoteRuntimePtyEnvironmentId(ptyId) : null
    if (owner) {
      owners.add(owner)
    }
  }
  owners.delete(environmentId)
  return [...owners].some((owner) => isLiveEnvironment(state, owner))
}
