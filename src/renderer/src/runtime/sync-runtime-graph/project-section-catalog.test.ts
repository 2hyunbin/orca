import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { getProjectSectionCatalogFromState } from './project-section-catalog'

const group: ProjectGroup = {
  id: 'g1',
  name: 'Notes',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0
}

describe('the sidebar catalog the window publishes for the phone', () => {
  it('carries project groups for a page reading the sidebar feed', () => {
    const catalog = getProjectSectionCatalogFromState({
      repos: [],
      projects: [],
      projectHostSetups: [],
      projectOrderBy: 'manual',
      projectGroups: [group]
    })
    expect(catalog?.projectGroups).toEqual([group])
  })
})
