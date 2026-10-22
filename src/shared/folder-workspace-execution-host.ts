/**
 * Resolves which host a folder workspace executes on.
 *
 * Main and the renderer both have to answer this — the list projects a record's
 * host from it, dispatch targets one from it — so the answer lives here rather
 * than being re-derived per side and drifting. The workspace's own
 * `executionHostId` pin wins: a pinned workspace runs there whatever its repos
 * say, which is exactly the case that used to read as local.
 *
 * `ambiguous` is a distinct answer, not a missing one: a scope that spans a
 * local repo and an SSH one has no single host, and callers must fail closed
 * with something visible rather than defaulting to local.
 */

import type { FolderWorkspace } from './folder-workspace-types'
import type { ProjectGroup } from './project-group-types'
import type { Repo } from './repo-types'
import { isPathInsideOrEqual } from './cross-platform-path'
import { getProjectGroupSubtreeIds } from './project-groups'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeHostPart,
  parseExecutionHostId,
  toSshExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from './execution-host'

export type FolderWorkspaceHostState = {
  folderWorkspaces: readonly FolderWorkspace[]
  projectGroups: readonly ProjectGroup[]
  repos: readonly Repo[]
}

/** The fields host resolution reads, so a catalog read over the wire resolves the same way. */
export type FolderHostRepo = {
  path: string
  projectGroupId?: string | null
  connectionId?: string | null
  executionHostId?: string | null
}

export type FolderHostCatalog<R extends FolderHostRepo = Repo> = {
  folderWorkspaces: readonly (Pick<FolderWorkspace, 'id' | 'folderPath' | 'projectGroupId'> & {
    connectionId?: string | null
    executionHostId?: string | null
  })[]
  projectGroups: readonly (Pick<ProjectGroup, 'id'> & {
    parentGroupId: string | null
    connectionId?: string | null
    executionHostId?: string | null
  })[]
  repos: readonly R[]
}

export type FolderWorkspaceHost =
  | { kind: 'missing' }
  | { kind: 'local' }
  | { kind: 'ssh'; targetId: string }
  // A paired server's folder; `sshTargetId` is that server's own target, addressable only with it.
  | { kind: 'runtime'; environmentId: string; sshTargetId: string | null }
  | { kind: 'ambiguous' }

/**
 * The SSH target whose filesystem holds this repo's files, or `null` for anything else.
 *
 * SSH ownership has two spellings on a repo row — the legacy `connectionId` field and the unified
 * `executionHostId` — so reading the raw field sees only one of them and a row carrying only
 * `executionHostId: 'ssh:<target>'` reads as if it had no connection at all. Every comparison in
 * this file goes through here: the candidate filters decide which rows reach the resolver, so
 * reading raw in either place drops the row before the resolver can classify it.
 *
 * A non-SSH host falls back to the raw field so a `runtime:` row keeps contributing its nested
 * target, which is not this client's to dial.
 */
function getRepoScopeConnectionId(repo: FolderHostRepo): string | null {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  return host?.kind === 'ssh' ? host.targetId : normalizeHostPart(repo.connectionId)
}

function getFolderScopeCandidateRepos<R extends FolderHostRepo>(args: {
  folderPath: string
  projectGroupId: string
  connectionId: string | null
  projectGroups: FolderHostCatalog<R>['projectGroups']
  repos: readonly R[]
}): R[] {
  const groupIds = getProjectGroupSubtreeIds(args.projectGroups, args.projectGroupId)
  // Classify each repo once. The previous pair of filters read every
  // projectGroupId twice before applying the same path predicate.
  const groupRepos: R[] = []
  const pathRepos: R[] = []
  for (const repo of args.repos) {
    const projectGroupId = repo.projectGroupId
    if (typeof projectGroupId === 'string' && groupIds.has(projectGroupId)) {
      groupRepos.push(repo)
    } else if (isPathInsideOrEqual(args.folderPath, repo.path)) {
      pathRepos.push(repo)
    }
  }
  if (args.connectionId) {
    return [
      ...groupRepos,
      ...pathRepos.filter((repo) => getRepoScopeConnectionId(repo) === args.connectionId)
    ]
  }
  if (groupRepos.length === 0) {
    return pathRepos
  }
  // Both sides resolved: comparing a resolved path repo against a raw group read would reintroduce
  // the same mismatch from the other direction.
  const groupConnectionIds = new Set(groupRepos.map(getRepoScopeConnectionId))
  return [
    ...groupRepos,
    ...pathRepos.filter((repo) => groupConnectionIds.has(getRepoScopeConnectionId(repo)))
  ]
}

export function findFolderWorkspaceCandidateRepos<R extends FolderHostRepo>(
  state: FolderHostCatalog<R>,
  folderWorkspaceId: string
): R[] {
  const rows = state.folderWorkspaces.filter((entry) => entry.id === folderWorkspaceId)
  return rows.length === 1 ? candidateReposForFolder(state, rows[0]) : []
}

function candidateReposForFolder<R extends FolderHostRepo>(
  state: FolderHostCatalog<R>,
  workspace: FolderHostCatalog<R>['folderWorkspaces'][number]
): R[] {
  const groups = state.projectGroups.filter((entry) => entry.id === workspace.projectGroupId)
  const connections = new Set(groups.map(getRepoScopeConnectionId))
  return getFolderScopeCandidateRepos({
    folderPath: workspace.folderPath,
    projectGroupId: workspace.projectGroupId,
    connectionId:
      normalizeHostPart(workspace.connectionId) ??
      (connections.size === 1 ? [...connections][0] : null),
    projectGroups: state.projectGroups,
    repos: state.repos
  })
}

export function resolveFolderWorkspaceHost<R extends FolderHostRepo>(
  state: FolderHostCatalog<R>,
  folderWorkspaceId: string
): FolderWorkspaceHost {
  const rows = state.folderWorkspaces.filter((entry) => entry.id === folderWorkspaceId)
  return rows.length === 0
    ? { kind: 'missing' }
    : rows.length !== 1
      ? { kind: 'ambiguous' }
      : resolveFolderWorkspaceRowHost(state, rows[0])
}

export function resolveFolderWorkspaceRowHost<R extends FolderHostRepo>(
  state: FolderHostCatalog<R>,
  workspace: FolderHostCatalog<R>['folderWorkspaces'][number]
): FolderWorkspaceHost {
  const groups = state.projectGroups.filter((entry) => entry.id === workspace.projectGroupId)
  const groupHosts = new Set(groups.map(getRepoExecutionHostId))
  const explicitHost =
    parseExecutionHostId(workspace.executionHostId) ??
    (!normalizeHostPart(workspace.connectionId) &&
    groupHosts.size === 1 &&
    groups.some(
      (group) =>
        parseExecutionHostId(group.executionHostId) || normalizeHostPart(group.connectionId)
    )
      ? parseExecutionHostId([...groupHosts][0])
      : null)
  const scopeConnections = new Set(groups.map(getRepoScopeConnectionId))
  const scopeConnectionId =
    normalizeHostPart(workspace.connectionId) ??
    (scopeConnections.size === 1 ? [...scopeConnections][0] : null)
  switch (explicitHost?.kind) {
    case 'ssh':
      return { kind: 'ssh', targetId: explicitHost.targetId }
    case 'runtime':
      return {
        kind: 'runtime',
        environmentId: explicitHost.environmentId,
        sshTargetId: scopeConnectionId
      }
    case 'local':
      return { kind: 'local' }
  }
  if (!normalizeHostPart(workspace.connectionId) && groupHosts.size > 1) {
    return { kind: 'ambiguous' }
  }
  const candidateRepos = candidateReposForFolder(state, workspace)
  let hasLocalRepo = false
  const connectionIds = new Set<string>()
  for (const repo of candidateRepos) {
    const connectionId = getRepoScopeConnectionId(repo)
    if (connectionId) {
      connectionIds.add(connectionId)
    } else {
      hasLocalRepo = true
    }
  }
  if (scopeConnectionId) {
    const hasDifferentSshConnection = [...connectionIds].some(
      (connectionId) => connectionId !== scopeConnectionId
    )
    return hasLocalRepo || hasDifferentSshConnection
      ? { kind: 'ambiguous' }
      : { kind: 'ssh', targetId: scopeConnectionId }
  }
  if (candidateRepos.length === 0 || connectionIds.size === 0) {
    return { kind: 'local' }
  }
  if (hasLocalRepo || connectionIds.size > 1) {
    return { kind: 'ambiguous' }
  }
  return { kind: 'ssh', targetId: [...connectionIds][0] }
}

export function getFolderWorkspaceHostId(
  workspace: FolderWorkspace,
  projectGroups: readonly ProjectGroup[]
): ExecutionHostId {
  const explicitHostId = parseExecutionHostId(workspace.executionHostId)?.id
  if (explicitHostId) {
    return explicitHostId
  }
  if (workspace.connectionId) {
    return toSshExecutionHostId(workspace.connectionId)
  }
  let matchingHostId: ExecutionHostId | undefined
  for (const group of projectGroups) {
    if (group.id !== workspace.projectGroupId) {
      continue
    }
    const hostId = getRepoExecutionHostId(group)
    if (matchingHostId === undefined) {
      matchingHostId = hostId
    } else if (matchingHostId !== hostId) {
      return LOCAL_EXECUTION_HOST_ID
    }
  }
  return matchingHostId ?? LOCAL_EXECUTION_HOST_ID
}

export function resolveQualifiedFolderWorkspaceResult(
  state: FolderWorkspaceHostState,
  folderWorkspaceId: string,
  requiredHostId?: ExecutionHostId
) {
  const rows = state.folderWorkspaces.filter((workspace) => workspace.id === folderWorkspaceId)
  let underivable = false
  const matches = rows.flatMap((workspace) => {
    const host = resolveFolderWorkspaceRowHost(state, workspace)
    const hostId =
      host.kind === 'local'
        ? LOCAL_EXECUTION_HOST_ID
        : host.kind === 'ssh'
          ? toSshExecutionHostId(host.targetId)
          : host.kind === 'runtime'
            ? toRuntimeExecutionHostId(host.environmentId)
            : null
    underivable ||= hostId === null
    return hostId && (!requiredHostId || hostId === requiredHostId)
      ? [
          {
            workspace,
            hostId,
            connectionId:
              host.kind === 'ssh'
                ? host.targetId
                : host.kind === 'runtime'
                  ? host.sshTargetId
                  : null
          }
        ]
      : []
  })
  return matches.length === 1
    ? { kind: 'selected' as const, value: matches[0] }
    : {
        kind:
          rows.length && (underivable || matches.length > 1)
            ? ('ambiguous' as const)
            : ('missing' as const)
      }
}

export function resolveQualifiedFolderWorkspace(
  ...args: Parameters<typeof resolveQualifiedFolderWorkspaceResult>
) {
  const result = resolveQualifiedFolderWorkspaceResult(...args)
  if (result.kind !== 'selected') {
    throw new Error('worktree_execution_host_unresolved')
  }
  return result.value
}
