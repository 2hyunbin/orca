import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectRemovalFailure, RepoSlice } from '../repos/repo-state'
import { selectProjectGroupRemovalTargets } from '../slices/project-group-removal-targets'
import { resolveProjectGroupOwnerHostId } from '../slices/project-group-owner-routing'
import { findRepoForHost, repoMatchesHostIdentity } from '../slices/repo-host-identity'
import { selectProjectGroups, selectRepos } from '../project-catalog-selectors'

/** Deletes a group on its owner host and, when asked, removes each contained project on its own. */
export async function deleteProjectGroupWithContainedProjects(
  get: Parameters<StateCreator<AppState>>[1],
  groupId: string,
  options: Parameters<RepoSlice['deleteProjectGroupWithContainedProjects']>[1]
): ReturnType<RepoSlice['deleteProjectGroupWithContainedProjects']> {
  const ownerHostId = resolveProjectGroupOwnerHostId(get(), groupId, options.hostId)
  const targets = selectProjectGroupRemovalTargets(
    selectProjectGroups(get()),
    selectRepos(get()),
    groupId,
    ownerHostId
  )
  const requestedProjectIds = options.removeContainedProjects ? targets.projectIds : []
  if (!targets.groupExists) {
    return {
      status: 'missing-group',
      groupId,
      requestedProjectIds,
      removedProjectIds: [],
      failedProjectRemovals: []
    }
  }

  const deleted = await get().deleteProjectGroup(groupId, {
    hostId: ownerHostId ?? undefined
  })
  if (!deleted) {
    return {
      status: 'group-delete-failed',
      groupId,
      requestedProjectIds,
      removedProjectIds: [],
      failedProjectRemovals: []
    }
  }

  if (!options.removeContainedProjects) {
    return {
      status: 'deleted-group',
      groupId,
      requestedProjectIds,
      removedProjectIds: [],
      failedProjectRemovals: []
    }
  }

  const removedProjectIds: string[] = []
  const failedProjectRemovals: ProjectRemovalFailure[] = []
  // Why: members were captured before the cascade cleared membership; a same-id row on another
  // host outside the group must survive, so each member row is removed on its own host.
  const membersById = new Map<string, Repo[]>()
  for (const member of targets.projects) {
    const row = findRepoForHost(selectRepos(get()), member.id, { hostId: member.hostId })
    if (row) {
      membersById.set(member.id, [...(membersById.get(member.id) ?? []), row])
    }
  }
  for (const projectId of new Set(targets.projectIds)) {
    const members = membersById.get(projectId) ?? []
    // Why: an unstamped group already routes to the focused host, so only that host's member is removed.
    const focusedMember = ownerHostId
      ? null
      : findRepoForHost(members, projectId, { settings: get().settings })
    const removable = ownerHostId ? members : focusedMember ? [focusedMember] : []
    const removableHostIds = removable.map((row) => getRepoExecutionHostId(row))
    for (const hostId of removableHostIds) {
      try {
        await get().removeProject(projectId, {
          hostId,
          confirmedDiscards: options.confirmedDiscards
        })
      } catch (err) {
        console.error('Failed to remove contained project:', err)
      }
    }
    // Why: an ambiguous unstamped member with no focused-host row was left in place, so it counts as remaining.
    const stillExists =
      (members.length > 0 && removableHostIds.length === 0) ||
      removableHostIds.some((hostId) =>
        selectRepos(get()).some((repo) => repoMatchesHostIdentity(repo, projectId, hostId))
      )
    if (stillExists) {
      failedProjectRemovals.push({
        projectId,
        reason: 'Project remained in Orca after removeProject completed.'
      })
    } else {
      removedProjectIds.push(projectId)
    }
  }

  return {
    status: 'deleted-group',
    groupId,
    requestedProjectIds,
    removedProjectIds,
    failedProjectRemovals
  }
}
