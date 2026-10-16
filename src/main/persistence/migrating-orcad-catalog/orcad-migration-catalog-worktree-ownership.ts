import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import { projectGroupIdFromRepoId } from '../../../shared/folder-workspace-worktree'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { splitWorktreeId } from '../../../shared/worktree/id'

export type OrcadMigrationWorktreeCatalog = Pick<
  OrcadMigrationManifest['payload'],
  'repositories' | 'projectGroups' | 'folderWorkspaces'
>

/** Whether `worktreeId` (a worktree id or folder workspace key) belongs to what this catalog moves. */
export function orcadMigrationCatalogOwnsWorktree(
  catalog: OrcadMigrationWorktreeCatalog,
  worktreeId: string
): boolean {
  if (
    catalog.folderWorkspaces.some((workspace) => folderWorkspaceKey(workspace.id) === worktreeId)
  ) {
    return true
  }
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed?.repoId || !parsed.worktreePath) {
    return false
  }
  const projectGroupId = projectGroupIdFromRepoId(parsed.repoId)
  return projectGroupId
    ? catalog.projectGroups.some((group) => group.id === projectGroupId)
    : catalog.repositories.some((repo) => repo.id === parsed.repoId)
}
