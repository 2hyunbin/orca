import type { AppState } from './types'

// The one read path for the project catalog: repos, project groups, projects and their host setups.
// Backed by today's store fields; readers go through here
// (config/scripts/check-project-catalog-read-ratchet.mjs).

export function selectRepos(state: Pick<AppState, 'repos'>): AppState['repos']
/** A reader typed on a narrower state shape. */
export function selectRepos<State extends { readonly repos?: unknown }>(
  state: State
): State['repos'] | AppState['repos']
export function selectRepos(state: { readonly repos?: unknown }): unknown {
  return state.repos
}

export function selectProjectGroups(
  state: Pick<AppState, 'projectGroups'>
): AppState['projectGroups']
export function selectProjectGroups<State extends { readonly projectGroups?: unknown }>(
  state: State
): State['projectGroups'] | AppState['projectGroups']
export function selectProjectGroups(state: { readonly projectGroups?: unknown }): unknown {
  return state.projectGroups
}

export function selectProjects(state: Pick<AppState, 'projects'>): AppState['projects']
export function selectProjects<State extends { readonly projects?: unknown }>(
  state: State
): State['projects'] | AppState['projects']
export function selectProjects(state: { readonly projects?: unknown }): unknown {
  return state.projects
}

export function selectProjectHostSetups(
  state: Pick<AppState, 'projectHostSetups'>
): AppState['projectHostSetups']
export function selectProjectHostSetups<State extends { readonly projectHostSetups?: unknown }>(
  state: State
): State['projectHostSetups'] | AppState['projectHostSetups']
export function selectProjectHostSetups(state: { readonly projectHostSetups?: unknown }): unknown {
  return state.projectHostSetups
}
