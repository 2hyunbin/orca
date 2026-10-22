import type { ProjectHostSetup } from '../../../../../../shared/project-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import type { AppState } from '../../../types'
import {
  selectProjectGroups,
  selectProjectHostSetups,
  selectRepos
} from '../../../project-catalog-selectors'
import { dropRuntimeHostedCatalogRows, isRemovedRuntimeHostId } from '../../stale-runtime-host-rows'

/** The catalog rows that survive removing `removed` runtime environments, and the repo ids each side
 *  still owns. */
export function partitionCatalogByRemovedHosts(
  s: Pick<AppState, 'repos' | 'projectHostSetups' | 'projectGroups'>,
  removed: ReadonlySet<string>
) {
  const repoIdsWithRemovedOwners = new Set<string>()
  const survivingRepoIds = new Set<string>()
  const repoIdsWithSurvivingOwners = new Set<string>()
  const survivingRepos: Repo[] = []
  for (const repo of selectRepos(s)) {
    if (isRemovedRuntimeHostId(getRepoExecutionHostId(repo), removed)) {
      repoIdsWithRemovedOwners.add(repo.id)
    } else {
      survivingRepos.push(repo)
      survivingRepoIds.add(repo.id)
      repoIdsWithSurvivingOwners.add(repo.id)
    }
  }
  const reposChanged = survivingRepos.length !== selectRepos(s).length

  // Why: a repoId-less setup on the removed host can still split a surviving project group, so drop every setup it owns.
  const survivingSetups: ProjectHostSetup[] = []
  for (const setup of selectProjectHostSetups(s)) {
    if (isRemovedRuntimeHostId(setup.hostId, removed)) {
      if (setup.repoId) {
        repoIdsWithRemovedOwners.add(setup.repoId)
      }
    } else {
      survivingSetups.push(setup)
      if (setup.repoId) {
        repoIdsWithSurvivingOwners.add(setup.repoId)
      }
    }
  }
  const setupsChanged = survivingSetups.length !== selectProjectHostSetups(s).length
  const projectGroups = dropRuntimeHostedCatalogRows(selectProjectGroups(s), removed)
  return {
    repoIdsWithRemovedOwners,
    survivingRepoIds,
    repoIdsWithSurvivingOwners,
    survivingRepos,
    reposChanged,
    survivingSetups,
    setupsChanged,
    survivingGroups: projectGroups
  }
}
