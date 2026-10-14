// Project sections as the desktop sidebar draws them under "Group by Project". The paired phone
// calls the same functions so its sections are the desktop's by construction.
import type { ExecutionHostId } from './execution-host'
import { toSshExecutionHostId } from './execution-host'
import type { Project, ProjectHostSetup } from './project-types'
import type { Repo } from './repo-types'
import { parseWslUncPath } from './wsl-paths'
import { isWindowsAbsolutePathLike, normalizeRuntimePathForComparison } from './cross-platform-path'

export type ProjectGroupingModel = {
  projects: readonly Project[]
  projectHostSetups: readonly ProjectHostSetup[]
}

export type ProjectGroupingIndex = {
  projectById: Map<string, Project>
  setupByRepoId: Map<string, ProjectHostSetup>
  surfaceKeysRequiringSetupGroups: Set<string>
}

/** The repo fields section grouping, labelling and ordering read. */
export type ProjectSectionRepo = {
  id: string
  displayName: string
  path: string
  addedAt?: number
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
}

/** One project section: its rows, the repo that anchors its header, and every repo it holds. */
export type ProjectSectionEntry<Item, R extends ProjectSectionRepo = Repo> = {
  label: string
  items: Item[]
  repo?: R
  repoIds: Set<string>
}

const projectGroupingIndexCache = new WeakMap<ProjectGroupingModel, ProjectGroupingIndex | null>()

// Why: provisioned and folder setups are not independent Git checkouts.
function isDistinctUserCheckout(setup: ProjectHostSetup): boolean {
  return setup.setupMethod !== 'provisioned' && setup.kind !== 'folder'
}

// Why: execution target and filesystem namespace independently identify a surface.
function getProjectSetupSurfaceKey(setup: ProjectHostSetup): string {
  return `${setup.projectId}::${setup.hostId}::${getExecutionSurface(setup)}::${getPathSurface(setup)}`
}

function getExecutionSurface(setup: ProjectHostSetup): string {
  const connectionId = setup.connectionId?.trim()
  if (connectionId) {
    return toSshExecutionHostId(connectionId)
  }
  return setup.executionHostId?.trim() || setup.hostId
}

// Why: projection twins differ by row identity, not checkout directory.
function getCheckoutIdentity(setup: ProjectHostSetup): string {
  return normalizeRuntimePathForComparison(setup.path.trim()) || setup.repoId || setup.id
}

function getPathSurface(setup: ProjectHostSetup): string {
  const wslPath = parseWslUncPath(setup.path)
  if (wslPath) {
    return `wsl:${wslPath.distro.toLowerCase()}`
  }
  if (isWindowsAbsolutePathLike(setup.path)) {
    return 'windows-host'
  }
  return 'default'
}

export function buildProjectGroupingIndex(
  model?: ProjectGroupingModel
): ProjectGroupingIndex | null {
  if (!model) {
    return null
  }
  const cached = projectGroupingIndexCache.get(model)
  if (cached !== undefined) {
    return cached
  }
  const projects = model.projects ?? []
  const projectHostSetups = model.projectHostSetups ?? []
  if (projects.length === 0 || projectHostSetups.length === 0) {
    projectGroupingIndexCache.set(model, null)
    return null
  }
  const checkoutsByProjectSurface = new Map<string, Set<string>>()
  for (const setup of projectHostSetups) {
    if (!isDistinctUserCheckout(setup)) {
      continue
    }
    const key = getProjectSetupSurfaceKey(setup)
    const existing = checkoutsByProjectSurface.get(key)
    if (existing) {
      existing.add(getCheckoutIdentity(setup))
    } else {
      checkoutsByProjectSurface.set(key, new Set([getCheckoutIdentity(setup)]))
    }
  }
  const surfaceKeysRequiringSetupGroups = new Set<string>()
  for (const [surfaceKey, checkouts] of checkoutsByProjectSurface) {
    if (checkouts.size > 1) {
      surfaceKeysRequiringSetupGroups.add(surfaceKey)
    }
  }
  const index = {
    projectById: new Map(projects.map((project) => [project.id, project])),
    setupByRepoId: new Map(projectHostSetups.map((setup) => [setup.repoId, setup])),
    surfaceKeysRequiringSetupGroups
  }
  projectGroupingIndexCache.set(model, index)
  return index
}

// Why: Settings splits projects by this same rule so it matches the sidebar headers.
export function isCheckoutScopedProjectSetup(
  setup: ProjectHostSetup,
  projectIndex: ProjectGroupingIndex
): boolean {
  return (
    projectIndex.surfaceKeysRequiringSetupGroups.has(getProjectSetupSurfaceKey(setup)) &&
    isDistinctUserCheckout(setup)
  )
}

export type ProjectHeaderRevealTarget<R extends Pick<ProjectSectionRepo, 'displayName'> = Repo> = {
  key: string
  label: string
  repo?: R
  projectId?: string
}

export function getProjectGroupingForRepo<R extends Pick<ProjectSectionRepo, 'displayName'>>(
  repoId: string,
  repoMap: ReadonlyMap<string, R>,
  projectIndex: ProjectGroupingIndex | null
): ProjectHeaderRevealTarget<R> {
  const repo = repoMap.get(repoId)
  const setup = projectIndex?.setupByRepoId.get(repoId)
  const project = setup ? projectIndex?.projectById.get(setup.projectId) : undefined
  if (!setup || !project) {
    return {
      key: `repo:${repoId}`,
      label: repo?.displayName ?? 'Unknown',
      repo
    }
  }
  if (projectIndex && isCheckoutScopedProjectSetup(setup, projectIndex)) {
    // Why: only the ambiguous surface needs checkout-specific headers.
    return {
      key: `project:${project.id}::setup:${repoId}`,
      label: repo?.displayName ?? setup.displayName,
      repo,
      projectId: project.id
    }
  }
  // Why: provisioned runtime copies and non-ambiguous checkouts follow project
  // identity rather than path-scoped setup identity, so they stay in one project.
  return {
    key: `project:${project.id}`,
    label: project.displayName,
    repo,
    projectId: project.id
  }
}

export function getProjectHeaderRevealTarget(
  repoId: string,
  repoMap: Map<string, Repo>,
  projectGrouping?: ProjectGroupingModel
): ProjectHeaderRevealTarget {
  return getProjectGroupingForRepo(repoId, repoMap, buildProjectGroupingIndex(projectGrouping))
}

/** Files `item` under its repo's project section, opening the section on first sight. */
export function addItemToProjectSection<Item, R extends ProjectSectionRepo>(
  sections: Map<string, ProjectSectionEntry<Item, R>>,
  item: Item,
  repoId: string,
  repoMap: ReadonlyMap<string, R>,
  projectIndex: ProjectGroupingIndex | null
): void {
  const grouping = getProjectGroupingForRepo(repoId, repoMap, projectIndex)
  let section = sections.get(grouping.key)
  if (!section) {
    section = { label: grouping.label, items: [], repo: grouping.repo, repoIds: new Set() }
    sections.set(grouping.key, section)
  }
  section.items.push(item)
  section.repoIds.add(repoId)
}

/**
 * Opens the project section for a repo that has no rows to file, or joins the repo to the open one.
 * `requireRepo` skips repo ids missing from the catalog, which would otherwise read "Unknown".
 */
export function ensureProjectSectionForRepo<Item, R extends ProjectSectionRepo>(
  sections: Map<string, ProjectSectionEntry<Item, R>>,
  repoId: string,
  repoMap: ReadonlyMap<string, R>,
  projectIndex: ProjectGroupingIndex | null,
  options: { requireRepo?: boolean; fallbackRepo?: R } = {}
): void {
  const grouping = getProjectGroupingForRepo(repoId, repoMap, projectIndex)
  if (options.requireRepo && !grouping.repo) {
    return
  }
  const section = sections.get(grouping.key)
  if (section) {
    section.repoIds.add(repoId)
    return
  }
  sections.set(grouping.key, {
    label: grouping.label,
    items: [],
    repo: grouping.repo ?? options.fallbackRepo,
    repoIds: new Set([repoId])
  })
}
