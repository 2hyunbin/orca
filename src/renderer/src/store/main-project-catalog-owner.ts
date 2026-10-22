import type { StateCreator } from 'zustand'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-inputs-switch'
import { scheduleSafeAutoForkSync } from './repos/safe-auto-fork-sync'
import { arrayElementsUnchanged } from './catalog-identity'
import type { AppState } from './types'
import type { StoreSetArgs } from './react-commit-cascade-write-probe'

/** The catalog fields main owns in a switched-on build; the window holds main's rows by reference. */
export type MainProjectCatalogRows = Pick<
  AppState,
  'repos' | 'projectGroups' | 'projects' | 'projectHostSetups'
>

let installing = false
const reportedWriters = new Set<string>()

function reportDroppedWrite(): void {
  // Only switched-on builds run this, and none ships: name each writer still to delete.
  const writer =
    new Error('dropped catalog write').stack?.split('\n').slice(3, 6).join(' <- ') ?? ''
  if (!reportedWriters.has(writer)) {
    reportedWriters.add(writer)
    console.warn(`[catalog] dropped a window write of main's project catalog: ${writer}`)
  }
}

function withoutMainCatalogFields<TState extends MainProjectCatalogRows>(
  partial: TState | Partial<TState>,
  current: TState
): Partial<TState> {
  const { repos, projectGroups, projects, projectHostSetups } = partial
  // A writer that hands back the whole state carries main's rows unchanged: only a change is a write.
  const changed =
    (repos !== undefined && repos !== current.repos) ||
    (projectGroups !== undefined && projectGroups !== current.projectGroups) ||
    (projects !== undefined && projects !== current.projects) ||
    (projectHostSetups !== undefined && projectHostSetups !== current.projectHostSetups)
  if (!changed) {
    return partial
  }
  reportDroppedWrite()
  const kept: Partial<TState> = { ...partial }
  delete kept.repos
  delete kept.projectGroups
  delete kept.projects
  delete kept.projectHostSetups
  return kept
}

/**
 * Switch point: main owns the project catalog (repos, groups, projects, setups). Every window
 * write of those fields is dropped; the one writer is the install of main's catalog below.
 */
export function withMainProjectCatalogOwner<TState extends MainProjectCatalogRows>(
  createState: StateCreator<TState, [], []>
): StateCreator<TState, [], []> {
  if (!ORCA_SIDEBAR_INPUTS_IS_MAIN) {
    return createState
  }
  return (set, get, api) => {
    const owned = (write: typeof set): typeof set => {
      const wrapped = (...args: StoreSetArgs<TState>): void => {
        // A full replace (only store resets) keeps what it is handed.
        if (args[1] === true) {
          write(...args)
          return
        }
        if (installing) {
          write(...args)
          return
        }
        const [partial] = args
        const current = get()
        write(
          withoutMainCatalogFields(
            typeof partial === 'function' ? partial(current) : partial,
            current
          )
        )
      }
      return wrapped
    }
    api.setState = owned(api.setState)
    return createState(owned(set), get, api)
  }
}

/** Installs main's catalog: the one write of its fields in a switched-on build. */
export function installMainProjectCatalog(
  api: {
    getState: () => MainProjectCatalogRows
    setState: (
      partial: MainProjectCatalogRows & Partial<Pick<AppState, 'folderWorkspacePathStatuses'>>
    ) => void
  },
  rows: MainProjectCatalogRows
): void {
  const previous = api.getState().repos
  const reposChanged = !arrayElementsUnchanged(rows.repos, previous)
  installing = true
  try {
    api.setState({ ...rows, ...(reposChanged ? { folderWorkspacePathStatuses: {} } : {}) })
  } finally {
    installing = false
  }
  if (reposChanged) {
    // As each catalog fetch did for the repos it read; the sync keeps its own cooldown per repo.
    const held = new Set(previous)
    scheduleSafeAutoForkSync(rows.repos.filter((repo) => !held.has(repo)))
  }
}
