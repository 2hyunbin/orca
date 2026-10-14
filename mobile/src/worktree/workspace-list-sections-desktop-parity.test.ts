import { describe, expect, it } from 'vitest'
import { getRepoExecutionHostId } from '../../../src/shared/execution-host'
import {
  PROJECT_SECTION_PARITY_HEADERS,
  PROJECT_SECTION_PARITY_ROWS,
  parityPhoneCatalog
} from '../../../src/shared/project-section-parity.test-fixture'
import { buildSections, type Worktree } from './workspace-list-sections'

// The desktop half lives in src/renderer/src/components/sidebar/
// worktree-list-groups-mobile-parity.test.ts: buildRows renders these same headers.
describe('Project grouping on the phone', () => {
  it.each(['recent', 'manual'] as const)(
    "renders the desktop sidebar's %s headers for the same host answers",
    (projectOrderBy) => {
      const catalog = parityPhoneCatalog()
      const repoById = new Map(catalog.repos.map((repo) => [repo.id, repo]))
      const rows: Worktree[] = PROJECT_SECTION_PARITY_ROWS.flatMap((row) => {
        const repo = repoById.get(row.repoId)
        return repo
          ? [
              {
                worktreeId: row.id,
                repoId: row.repoId,
                hostId: getRepoExecutionHostId(repo),
                repo: repo.displayName,
                branch: 'feature',
                displayName: row.id,
                path: `${repo.path}-${row.id}`,
                lastActivityAt: row.lastActivityAt,
                liveTerminalCount: 0,
                hasAttachedPty: false,
                unread: false,
                isPinned: false,
                linkedPR: null
              }
            ]
          : []
      })

      const sections = buildSections(
        rows,
        'recent',
        { filterRepoIds: new Set(), hideSleeping: false, hideDefaultBranch: false },
        '',
        'repo',
        new Set(),
        { repos: catalog.repos, grouping: catalog.grouping, projectOrderBy }
      )

      expect(rows).toHaveLength(PROJECT_SECTION_PARITY_ROWS.length)
      expect(sections.map((section) => ({ key: section.key, label: section.title }))).toEqual(
        PROJECT_SECTION_PARITY_HEADERS
      )
    }
  )
})
