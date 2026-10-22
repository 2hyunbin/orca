import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { RepoSlice } from './repo-state'
import { getRepoExecutionHostId, toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import {
  awaitMainProjectCatalog,
  awaitMainProjectCatalogWrite,
  followMainProjectCatalog
} from '@/lib/main-project-catalog'
import { installMainProjectCatalog } from '../main-project-catalog-owner'
import { readRuntimeWorktreeVisibilitySnapshot } from '../slices/worktree-visibility-owner-settings'
import { isRemovedRuntimeHostId } from '../slices/stale-runtime-host-rows'
import { loadRuntimeHostCatalogs } from '../host-catalog-fencing'

type MainCatalogFetchActions = Pick<
  RepoSlice,
  | 'fetchRepos'
  | 'fetchReposForAllHosts'
  | 'awaitLocalRepoCatalogSettlement'
  | 'fetchRuntimeEnvironmentRepos'
  | 'fetchProjectGroups'
  | 'fetchProjectGroupsForAllHosts'
>

/**
 * Switch point: the catalog reads of a window that holds main's catalog. Each waits for main's
 * catalog to be current instead of fetching its own; only a paired server's worktree-visibility
 * defaults, which the catalog does not carry, are still read here.
 */
export function createMainCatalogFetchActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): MainCatalogFetchActions {
  const readVisibilityDefaults = async (environmentId: string): Promise<void> => {
    const snapshot = await readRuntimeWorktreeVisibilitySnapshot(environmentId)
    const hostId = toRuntimeExecutionHostId(environmentId)
    if (snapshot.defaults === undefined) {
      return
    }
    const defaults = snapshot.defaults
    set((state) =>
      isRemovedRuntimeHostId(hostId, state.removedRuntimeEnvironmentIds)
        ? state
        : {
            worktreeVisibilityDefaultsByHost: {
              ...state.worktreeVisibilityDefaultsByHost,
              [hostId]: defaults
            },
            // Names a server whose source defaults the settings page may offer; the page reads it
            // only for its default host, so no focus read is needed here.
            ...(snapshot.sourceDefaultsSupported
              ? { worktreeVisibilitySourceDefaultsSupportedRuntimeEnvironmentId: environmentId }
              : state.worktreeVisibilitySourceDefaultsSupportedRuntimeEnvironmentId ===
                  environmentId
                ? { worktreeVisibilitySourceDefaultsSupportedRuntimeEnvironmentId: null }
                : {})
          }
    )
  }
  // The first catalog read (startup's) starts following main; its install is the one writer.
  const follow = (): void =>
    followMainProjectCatalog((rows) =>
      installMainProjectCatalog({ getState: get, setState: set }, rows)
    )
  const current = async (): Promise<void> => {
    follow()
    await awaitMainProjectCatalog()
    await awaitMainProjectCatalogWrite()
  }
  return {
    fetchRepos: current,
    fetchReposForAllHosts: async (options) => {
      await current()
      if (options?.remoteHosts !== 'skip') {
        await loadRuntimeHostCatalogs(get, 'repos', (target) =>
          readVisibilityDefaults(target.environmentId)
        )
      }
    },
    awaitLocalRepoCatalogSettlement: async () => {
      follow()
      await awaitMainProjectCatalog()
    },
    fetchRuntimeEnvironmentRepos: async (environmentId) => {
      const hostId = toRuntimeExecutionHostId(environmentId)
      const ofHost = (): AppState['repos'] =>
        get().repos.filter((repo) => getRepoExecutionHostId(repo) === hostId)
      follow()
      // A just-connected server reaches main's catalog once main has read it.
      await Promise.all([
        awaitMainProjectCatalogWrite((catalog) =>
          catalog.repos.some((repo) => getRepoExecutionHostId(repo) === hostId)
        ),
        readVisibilityDefaults(environmentId)
      ])
      return [...ofHost()]
    },
    fetchProjectGroups: current,
    fetchProjectGroupsForAllHosts: current
  }
}
