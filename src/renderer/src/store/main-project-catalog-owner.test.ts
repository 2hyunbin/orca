import { afterEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from './types'
import type { Repo } from '../../../shared/repo-types'

vi.mock('../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

const { installMainProjectCatalog, withMainProjectCatalogOwner } =
  await import('./main-project-catalog-owner')

type CatalogState = Pick<
  AppState,
  'repos' | 'projectGroups' | 'projects' | 'projectHostSetups' | 'folderWorkspacePathStatuses'
> & { activeRepoId: string | null }

function repo(id: string): Repo {
  return { id, path: `/${id}`, displayName: id, badgeColor: '', addedAt: 0 }
}

function store() {
  return create<CatalogState>()(
    withMainProjectCatalogOwner<CatalogState>(() => ({
      repos: [],
      projectGroups: [],
      projects: [],
      projectHostSetups: [],
      folderWorkspacePathStatuses: {},
      activeRepoId: null
    }))
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('withMainProjectCatalogOwner', () => {
  it("drops a window write of main's catalog and keeps the rest of the write", () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const state = store()
    state.setState({ repos: [repo('window-only')], activeRepoId: 'a' })
    expect(state.getState().repos).toEqual([])
    expect(state.getState().activeRepoId).toBe('a')
  })

  it('keeps a writer that hands back the whole state, without reporting it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const state = store()
    state.setState((s) => ({ ...s, activeRepoId: 'b' }))
    expect(state.getState().activeRepoId).toBe('b')
    expect(warn).not.toHaveBeenCalled()
  })

  it("installs main's rows by reference", () => {
    const state = store()
    const repos = [repo('main')]
    installMainProjectCatalog(state, {
      repos,
      projectGroups: [],
      projects: [],
      projectHostSetups: []
    })
    expect(state.getState().repos).toBe(repos)
  })
})
