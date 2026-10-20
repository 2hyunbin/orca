import type { AppState } from '@/store/types'
import { getProjectSectionCatalogFromState } from '@/runtime/sync-runtime-graph/project-section-catalog'
import type { SidebarFeedCatalog } from '../../../../shared/sidebar-list/sidebar-feed-rows'
import { group, mainWt, repo, wt } from './sidebar-list-golden-factories.test-fixture'

// A group ahead of every other holding a git project and a folder project, a child group of it holding
// only a folder project, and an empty group: the phone must file each project under its group, in order.
const lake = repo('lake', 'Lake', { projectGroupId: 'pg-school', projectGroupOrder: 1 })
const capstone = repo('capstone', 'capstone', {
  kind: 'folder',
  projectGroupId: 'pg-school',
  projectGroupOrder: 0
})
const notes = repo('notes', 'notes', { kind: 'folder', projectGroupId: 'pg-folder-only' })
export const GROUPED_REPOS = [lake, capstone, notes]
export const GROUPED_WORKTREES: AppState['worktreesByRepo'] = {
  lake: [mainWt(lake), wt(lake, 'essay', { sortOrder: 5 })],
  capstone: [mainWt(capstone, { branch: '' })],
  notes: [mainWt(notes, { branch: '' })]
}
export const GROUPS_OF_GROUPED_REPOS = [
  group('pg-school', 'school', { tabOrder: -1, color: '#22c55e' }),
  group('pg-folder-only', 'Folder only', { tabOrder: 5, parentGroupId: 'pg-school' }),
  group('pg-empty', 'Empty group', { tabOrder: 6 })
]

/**
 * The catalog the window publishes (mobileRelay.projectSections), which is all the phone knows of
 * its repos and groups. The phone's own read of it is held by host-sidebar-feed-inputs tests.
 */
export function publishedCatalog(state: AppState): SidebarFeedCatalog {
  const published = getProjectSectionCatalogFromState(state)
  if (!published) {
    throw new Error('the window published no catalog')
  }
  return {
    repos: published.repos.map((entry) => ({ addedAt: 0, ...entry })),
    projectGroups: published.projectGroups ?? [],
    projectGrouping: { projects: published.projects, projectHostSetups: published.setups }
  }
}
