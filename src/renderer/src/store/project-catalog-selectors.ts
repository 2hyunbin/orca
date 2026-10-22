import type { AppState } from './types'

// The one read path for the project catalog: repos, project groups, projects and their host setups.
// Backed by today's store fields; readers go through here
// (config/scripts/check-project-catalog-read-ratchet.mjs).

export function selectRepos(state: Pick<AppState, 'repos'>): AppState['repos'] {
  return state.repos
}

export function selectProjectGroups(
  state: Pick<AppState, 'projectGroups'>
): AppState['projectGroups'] {
  return state.projectGroups
}

export function selectProjects(state: Pick<AppState, 'projects'>): AppState['projects'] {
  return state.projects
}

export function selectProjectHostSetups(
  state: Pick<AppState, 'projectHostSetups'>
): AppState['projectHostSetups'] {
  return state.projectHostSetups
}
