import { describe, expect, it } from 'vitest'
import type { ServedProjectSections } from '../../../../../../shared/project-section-catalog-schema'
import type { Repo } from '../../../../../../shared/repo-types'
import { joinMainSidebarCatalog } from './main-sidebar-catalog'

const group = {
  id: 'g1',
  name: 'Group',
  parentPath: null,
  parentGroupId: null,
  connectionId: undefined,
  executionHostId: undefined,
  createdFrom: 'manual' as const,
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

type ServedRepo = ServedProjectSections['repos'][number]

function servedRepo(fields: Pick<ServedRepo, 'id' | 'path'> & Partial<ServedRepo>): ServedRepo {
  return {
    displayName: fields.id,
    badgeColor: undefined,
    addedAt: undefined,
    connectionId: undefined,
    executionHostId: undefined,
    projectGroupId: undefined,
    projectGroupOrder: undefined,
    ...fields
  }
}

function served(repos: ServedRepo[]): ServedProjectSections {
  return {
    repos,
    projects: [],
    setups: [],
    projectOrderBy: 'manual',
    projectGroups: [group]
  }
}

function windowRepo(fields: Partial<Repo> & Pick<Repo, 'id'>): Repo {
  return { path: '/old', displayName: 'old', badgeColor: '#000', addedAt: 5, ...fields }
}

describe('joinMainSidebarCatalog', () => {
  it("lists main's repos in main's order, with main's names, colour and group", () => {
    const catalog = joinMainSidebarCatalog(
      served([
        servedRepo({
          id: 'b',
          displayName: 'B',
          path: '/b',
          badgeColor: '#b',
          projectGroupId: 'g1'
        }),
        servedRepo({ id: 'a', displayName: 'A', path: '/a', badgeColor: '#a' })
      ]),
      [
        windowRepo({ id: 'a', kind: 'folder', projectGroupId: 'stale' }),
        windowRepo({ id: 'b', kind: 'git', worktreeBaseRef: 'main' })
      ]
    )
    expect(catalog.repos.map((repo) => repo.id)).toEqual(['b', 'a'])
    expect(catalog.repos[0]).toMatchObject({
      displayName: 'B',
      badgeColor: '#b',
      projectGroupId: 'g1',
      worktreeBaseRef: 'main',
      addedAt: 5
    })
    // A move out of a group is main's to say, whatever the window last held.
    expect(catalog.repos[1]).toMatchObject({ kind: 'folder', projectGroupId: undefined })
    expect(catalog.projectGroups).toEqual([group])
    expect(catalog.repoMap.get('a')).toBe(catalog.repos[1])
  })

  it('never lists a repo only the window holds, and joins details by host', () => {
    const catalog = joinMainSidebarCatalog(
      served([servedRepo({ id: 'a', displayName: 'A', path: '/a', connectionId: 'gpu' })]),
      [windowRepo({ id: 'a', kind: 'folder' }), windowRepo({ id: 'gone' })]
    )
    expect(catalog.repos.map((repo) => repo.id)).toEqual(['a'])
    expect(catalog.repos[0]?.kind).toBeUndefined()
  })

  it('lists nothing before main has served a catalog', () => {
    const catalog = joinMainSidebarCatalog(null, [windowRepo({ id: 'a' })])
    expect(catalog.repos).toEqual([])
    expect(catalog.projectGroups).toEqual([])
  })
})
