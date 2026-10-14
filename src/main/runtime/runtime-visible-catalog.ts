/**
 * The projects a client may list: the same rows the desktop sidebar shows. A converted SSH host's
 * source rows and a WSL host's moved rows stay in the store for a downgrade, but the server that
 * now owns them lists them. Internal callers (routing, selectors, migration) keep the full store.
 */
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import {
  visibleFolderWorkspaces,
  visibleProjectGroups,
  visibleRepos
} from '../ssh/orcad-retained-source'
import type { RuntimeStore } from './runtime-store-contract'

type CatalogSource = Pick<
  RuntimeStore,
  'getRepos' | 'getProjectGroups' | 'getFolderWorkspaces' | 'getSshTargets'
>

// Headless orcad has no SSH targets, so nothing of its own is ever a retained source.
function catalogStore(store: CatalogSource) {
  return {
    getRepos: () => store.getRepos(),
    getProjectGroups: () => store.getProjectGroups?.() ?? [],
    getFolderWorkspaces: () => store.getFolderWorkspaces?.() ?? [],
    getSshTargets: () => store.getSshTargets?.() ?? []
  }
}

export function runtimeVisibleRepos(store: CatalogSource | null): Repo[] {
  return store ? visibleRepos(catalogStore(store)) : []
}

export function runtimeVisibleProjectGroups(store: CatalogSource | null): ProjectGroup[] {
  return store ? visibleProjectGroups(catalogStore(store)) : []
}

export function runtimeVisibleFolderWorkspaces(store: CatalogSource | null): FolderWorkspace[] {
  return store ? visibleFolderWorkspaces(catalogStore(store)) : []
}

/** Repos in the store that clients must not see; empty in the common case of nothing hidden. */
export function runtimeHiddenRepoIds(store: CatalogSource | null): ReadonlySet<string> {
  if (!store) {
    return new Set()
  }
  const all = store.getRepos()
  const visible = runtimeVisibleRepos(store)
  if (visible.length === all.length) {
    return new Set()
  }
  const visibleIds = new Set(visible.map((repo) => repo.id))
  return new Set(all.filter((repo) => !visibleIds.has(repo.id)).map((repo) => repo.id))
}
