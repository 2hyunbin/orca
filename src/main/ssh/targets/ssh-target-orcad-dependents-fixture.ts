import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { DependentStateStore } from './ssh-target-orcad-dependents'

/** A store with no client state referencing any SSH target. */
export function emptyDependentStateStore(
  overrides: Partial<DependentStateStore> = {}
): DependentStateStore {
  return {
    getAllWorktreeMetaForHost: () => ({}),
    getRepos: () => [],
    getSshRemotePtyLeases: () => [],
    getWorkspaceSession: () => getDefaultWorkspaceSession(),
    getWorkspaceSessionHostIds: () => ['local'],
    listAutomations: () => [],
    ...overrides
  }
}
