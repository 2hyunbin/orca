import { describe, expect, it } from 'vitest'
import { adoptEndpointProjectCatalog } from '../../../../shared/endpoint-catalog-adoption'
import { mergeFetchedHostProjectCatalog } from '../../../../shared/project-compatibility-host-merge'
import type { ProjectCatalogRows } from '../../../../shared/project-compatibility-merge'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { buildProjectGroupingIndex } from '../../../../shared/project-section-grouping'
import { buildProjectSections } from '../../../../shared/project-section-order'
import {
  PROJECT_SECTION_PARITY_HEADERS,
  PROJECT_SECTION_PARITY_HOSTS,
  PROJECT_SECTION_PARITY_ROWS,
  parityHostProjectLists,
  parityPhoneCatalog
} from '../../../../shared/project-section-parity.test-fixture'
import type { Repo } from '../../../../shared/repo-types'
import type { ProjectOrderBy } from '../../../../shared/ui-chrome-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { adoptFromEndpoint } from '../../store/adopt-from-endpoint'
import { getProjectHostSetupProjectionFromState } from '../../store/project-host-setup-selector'
import { buildRows } from './worktree-list/grouping/build-rows'
import { worktree as worktreeFixture } from './worktree-list-groups-test-fixtures'

// Why: the phone's Project sections must be the desktop sidebar's by construction. The desktop
// side here runs the renderer's own fold, selector and buildRows; the phone side runs the shared
// fold and section builder its buildSections calls (mobile/src/worktree/
// workspace-list-sections-desktop-parity.test.ts pins buildSections to the same headers).

function desktopHeaders(projectOrderBy: ProjectOrderBy): { key: string; label: string }[] {
  // The renderer's all-host load: each host's catalog folded in, then its projection selector.
  let repos: Repo[] = []
  let catalog: ProjectCatalogRows = { projects: [], projectHostSetups: [] }
  for (const host of PROJECT_SECTION_PARITY_HOSTS) {
    const adopted = host.repos.map((repo) =>
      adoptFromEndpoint(host.target, { kind: 'repo', row: repo })
    )
    repos = [...repos, ...adopted]
    const lists = parityHostProjectLists(host)
    catalog = mergeFetchedHostProjectCatalog({
      previous: catalog,
      fetched: host.answersProjectLists
        ? adoptEndpointProjectCatalog(host.target, lists.projects, lists.setups)
        : projectHostSetupProjectionFromRepos(adopted),
      repos,
      hostId: host.hostId
    })
  }
  const projection = getProjectHostSetupProjectionFromState({ repos, ...catalog })
  const worktrees: Worktree[] = PROJECT_SECTION_PARITY_ROWS.map((row) => ({
    ...worktreeFixture,
    id: row.id,
    repoId: row.repoId,
    lastActivityAt: row.lastActivityAt
  }))
  const withWorktrees = new Set(PROJECT_SECTION_PARITY_ROWS.map((row) => row.repoId))
  return buildRows(
    'repo',
    worktrees,
    new Map(repos.map((repo) => [repo.id, repo])),
    null,
    new Set(),
    undefined,
    undefined,
    projectOrderBy,
    {},
    undefined,
    false,
    undefined,
    [],
    new Set(repos.filter((repo) => !withWorktrees.has(repo.id)).map((repo) => repo.id)),
    new Map(),
    new Map(),
    [],
    { projects: projection.projects, projectHostSetups: projection.setups }
  ).flatMap((row) => (row.type === 'header' ? [{ key: row.key, label: row.label }] : []))
}

function phoneHeaders(projectOrderBy: ProjectOrderBy): { key: string; label: string }[] {
  const catalog = parityPhoneCatalog()
  const withRows = new Set(PROJECT_SECTION_PARITY_ROWS.map((row) => row.repoId))
  return buildProjectSections({
    items: PROJECT_SECTION_PARITY_ROWS,
    repoIdOf: (row) => row.repoId,
    placeholderRepoIds: catalog.repos
      .filter((repo) => !withRows.has(repo.id))
      .map((repo) => repo.id),
    repoMap: new Map(catalog.repos.map((repo) => [repo.id, repo])),
    projectIndex: buildProjectGroupingIndex(catalog.grouping),
    repoOrder: undefined,
    projectOrderBy
  }).map(([key, section]) => ({ key, label: section.label }))
}

describe('the phone groups by Project exactly as the paired desktop sidebar', () => {
  it.each(['recent', 'manual'] as const)(
    'gives checkouts of one project on local and servers the same %s headers',
    (projectOrderBy) => {
      // Manual: the phone never learns the desktop's repo order, so this pins the shared rule with
      // none supplied (first-row order, which the fixture's rows make equal to Recent).
      expect(desktopHeaders(projectOrderBy)).toEqual(PROJECT_SECTION_PARITY_HEADERS)
      expect(phoneHeaders(projectOrderBy)).toEqual(PROJECT_SECTION_PARITY_HEADERS)
    }
  )
})
