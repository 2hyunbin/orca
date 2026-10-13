/**
 * Which local projects a move into a distro's host may take (mover design, section 1): a repo or
 * folder workspace on host `local` whose every path is a UNC path of that distro, never through a
 * Windows drive mount. Anything that touches the distro but breaks the rule is refused with a
 * reason, so the preview can say why instead of silently leaving it behind.
 */
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { Repo } from '../../../shared/repo-types'
import { isDrvfsLinuxPath, parseWslUncPath } from '../../../shared/wsl-paths'
import { wslUncPathToLinux } from './wsl-move-path-rewriter'

export type WslMoveScopeRefusal =
  /** Its folder sits on a Windows drive reached through the distro; it stays a Windows project. */
  | 'windows-drive'
  /** Some of its paths are in another distro or on Windows. */
  | 'mixed-locations'
  /** It already runs on another host. */
  | 'not-local'

export type WslMoveScope = {
  repoIds: string[]
  folderWorkspaceIds: string[]
  refused: { kind: 'repo' | 'folder-workspace'; id: string; reason: WslMoveScopeRefusal }[]
}

export function collectWslMoveScope(
  state: { repos: readonly Repo[]; folderWorkspaces: readonly FolderWorkspace[] },
  distro: string
): WslMoveScope {
  const scope: WslMoveScope = { repoIds: [], folderWorkspaceIds: [], refused: [] }
  for (const repo of state.repos) {
    if (!inDistro(repo.path, distro)) {
      continue
    }
    const paths = [
      repo.path,
      // A relative base path stays inside the repo; an absolute one must stay in the distro too.
      ...(repo.worktreeBasePath && isAbsoluteWindowsSidePath(repo.worktreeBasePath)
        ? [repo.worktreeBasePath]
        : []),
      ...(repo.externalWorktreeInboxBaselinePaths ?? []),
      ...(repo.importedExternalWorktreePaths ?? [])
    ]
    const reason = refusalFor(paths, distro, getRepoExecutionHostId(repo) !== 'local')
    if (reason) {
      scope.refused.push({ kind: 'repo', id: repo.id, reason })
    } else {
      scope.repoIds.push(repo.id)
    }
  }
  for (const workspace of state.folderWorkspaces) {
    if (!inDistro(workspace.folderPath, distro)) {
      continue
    }
    const reason = refusalFor([workspace.folderPath], distro, Boolean(workspace.connectionId))
    if (reason) {
      scope.refused.push({ kind: 'folder-workspace', id: workspace.id, reason })
    } else {
      scope.folderWorkspaceIds.push(workspace.id)
    }
  }
  return scope
}

function isAbsoluteWindowsSidePath(path: string): boolean {
  return parseWslUncPath(path) !== null || /^(?:[A-Za-z]:)?[\\/]/.test(path)
}

function inDistro(path: string, distro: string): boolean {
  return wslUncPathToLinux(path, distro) !== null
}

function refusalFor(
  paths: readonly string[],
  distro: string,
  remote: boolean
): WslMoveScopeRefusal | null {
  if (remote) {
    return 'not-local'
  }
  const linuxPaths = paths.map((path) => wslUncPathToLinux(path, distro))
  if (linuxPaths.some((path) => path === null)) {
    return 'mixed-locations'
  }
  return linuxPaths.some((path) => path !== null && isDrvfsLinuxPath(path)) ? 'windows-drive' : null
}
