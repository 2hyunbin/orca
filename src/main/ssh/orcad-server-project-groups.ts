/** The project groups a managed server already holds, so a relink keeps its record of them. */
import { isRepoOnCatalogHost } from '../../shared/execution-host'
import type { OrcadMigrationCatalogPayload } from '../../shared/orcad-migration/orcad-migration-manifest'
import type { OrcadServerFolderCatalog } from './orcad-server-folder-workspaces'

/**
 * Incoming groups the server holds under the same id on its own machine: its copy from an earlier
 * move, found even when no server row sits in it. One it keeps for another host isn't the same.
 */
export function projectGroupsHeldByServer(
  incoming: readonly { id: string }[],
  server: Pick<OrcadServerFolderCatalog, 'projectGroups'>
): string[] {
  const local = new Set(server.projectGroups.filter(isRepoOnCatalogHost).map((group) => group.id))
  return incoming.filter((group) => local.has(group.id)).map((group) => group.id)
}

/**
 * Source groups the server holds or its projects sit in, and their ancestors, renamed there
 * perhaps since: re-importing this desktop's retained copy would conflict with the server's. An
 * ancestor the server may lack still moves while a moving row needs it.
 */
export function serverHeldProjectGroups(
  payload: Pick<
    OrcadMigrationCatalogPayload,
    'repositories' | 'folderWorkspaces' | 'projectGroups'
  >,
  linked: { repositoryIds: ReadonlySet<string>; folderWorkspaceIds: ReadonlySet<string> },
  server: readonly { projectGroupId?: string | null }[],
  serverGroupIds: readonly string[]
): string[] {
  const parentById = new Map(payload.projectGroups.map((group) => [group.id, group.parentGroupId]))
  const held = new Set([
    ...serverGroupIds,
    ...server.flatMap((row) => (row.projectGroupId ? [row.projectGroupId] : []))
  ])
  const withAncestors = (ids: (string | null | undefined)[], stopAt: ReadonlySet<string>) => {
    const out = new Set<string>()
    while (ids.length > 0) {
      const id = ids.pop()
      if (id && !out.has(id) && !stopAt.has(id) && parentById.has(id)) {
        out.add(id)
        ids.push(parentById.get(id))
      }
    }
    return out
  }
  const candidates = withAncestors([...held], new Set())
  const needed = withAncestors(
    [
      ...payload.repositories
        .filter((repo) => !linked.repositoryIds.has(repo.id))
        .map((repo) => repo.projectGroupId),
      ...payload.folderWorkspaces
        .filter((workspace) => !linked.folderWorkspaceIds.has(workspace.id))
        .map((workspace) => workspace.projectGroupId),
      ...payload.projectGroups
        .filter((group) => !candidates.has(group.id))
        .map((group) => group.parentGroupId)
    ],
    held
  )
  return [...candidates].filter((id) => !needed.has(id))
}
