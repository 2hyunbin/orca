import type { Store } from '../persistence'
import type { ResolvedRuntimeFileTarget } from './runtime-file-command-target'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { resolveFolderWorkspaceHost } from '../../shared/folder-workspace-execution-host'
import { parseExecutionHostId } from '../../shared/execution-host'
import { resolveWorktreeHostRouting } from './worktree-launch-host-repo'

export type RuntimeViewerWorkspaceCatalog = Pick<
  Store,
  'getRepos' | 'getProjectGroups' | 'getFolderWorkspaces'
>

export function runtimeViewerWorkspaceOwnership(
  catalog: RuntimeViewerWorkspaceCatalog,
  target: ResolvedRuntimeFileTarget
): string | null {
  const scope = parseWorkspaceKey(target.worktree.id)
  const repos = catalog.getRepos()
  if (scope?.type === 'folder') {
    const rows = catalog.getFolderWorkspaces().filter((row) => row.id === scope.folderWorkspaceId)
    if (rows.length !== 1) {
      return null
    }
    const row = rows[0]
    if (
      normalizeRuntimePathForComparison(row.folderPath) !==
        normalizeRuntimePathForComparison(target.worktree.path) ||
      (row.executionHostId?.trim() && row.executionHostId !== target.executionHostId)
    ) {
      return null
    }
    const owner = resolveFolderWorkspaceHost(
      { repos, projectGroups: catalog.getProjectGroups(), folderWorkspaces: rows },
      row.id
    )
    const host = parseExecutionHostId(target.executionHostId)
    const owned =
      (owner.kind === 'local' && host?.kind === 'local') ||
      (owner.kind === 'ssh' && host?.kind === 'ssh' && owner.targetId === host.targetId)
    return owned
      ? JSON.stringify([row.id, row.projectGroupId, row.folderPath, target.executionHostId])
      : null
  }
  const routing = resolveWorktreeHostRouting(repos, target.worktree)
  const owned =
    routing.kind === 'resolved' &&
    routing.hostId === target.executionHostId &&
    routing.repo !== null &&
    (routing.repo.kind !== 'folder' ||
      normalizeRuntimePathForComparison(routing.repo.path) ===
        normalizeRuntimePathForComparison(target.worktree.path))
  return owned && routing.kind === 'resolved' && routing.repo
    ? JSON.stringify([
        routing.repo.id,
        routing.repo.kind ?? 'git',
        routing.repo.path,
        target.executionHostId
      ])
    : null
}
