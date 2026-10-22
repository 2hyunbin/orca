import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import { awaitMainProjectCatalogWrite } from '@/lib/main-project-catalog'
import { projectGroupMatchesOwnerHost } from '../slices/project-group-owner-routing'
import { isSameRepoRow } from '../slices/repo-host-identity'

function awaitMainShowsGroup(
  group: ProjectGroup,
  ownerHostId: ExecutionHostId | null
): Promise<boolean> {
  return awaitMainProjectCatalogWrite((catalog) =>
    catalog.projectGroups.some(
      (shown) =>
        projectGroupMatchesOwnerHost(shown, group.id, ownerHostId) &&
        shown.updatedAt >= group.updatedAt
    )
  )
}

function awaitMainDropsGroup(
  groupId: string,
  ownerHostId: ExecutionHostId | null
): Promise<boolean> {
  return awaitMainProjectCatalogWrite(
    (catalog) =>
      !catalog.projectGroups.some((shown) =>
        projectGroupMatchesOwnerHost(shown, groupId, ownerHostId)
      )
  )
}

function awaitMainShowsMove(moved: Repo): Promise<boolean> {
  return awaitMainProjectCatalogWrite((catalog) =>
    catalog.repos.some(
      (shown) =>
        isSameRepoRow(shown, moved) &&
        (shown.projectGroupId ?? null) === (moved.projectGroupId ?? null)
    )
  )
}

/** Each resolves once main's catalog shows the write (false after the limit). */
export const mainCatalogShows = {
  group: awaitMainShowsGroup,
  groupGone: awaitMainDropsGroup,
  move: awaitMainShowsMove
}
