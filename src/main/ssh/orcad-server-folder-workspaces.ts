/** The folder workspaces a managed server already holds, so a move links them (#27285). */
import { z } from 'zod'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { isRepoOnCatalogHost } from '../../shared/execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import { listServerRows, type CatalogRequestOptions } from './orcad-migration-catalog-client'

export type OrcadServerFolderWorkspace = Pick<
  FolderWorkspace,
  'id' | 'folderPath' | 'projectGroupId'
> & { connectionId?: string | null; executionHostId?: string | null }

const ServerFolderWorkspacesSchema = z.object({
  folderWorkspaces: z.array(
    z.object({
      id: z.string().min(1),
      folderPath: z.string().min(1),
      projectGroupId: z.string().min(1),
      connectionId: z.string().nullish(),
      executionHostId: z.string().nullish()
    })
  )
})

/** The folder workspaces the destination already holds, with the host each one's folder is on. */
export async function listRemoteOrcadFolderWorkspaces(
  pairingCode: string,
  options: CatalogRequestOptions = {}
): Promise<OrcadServerFolderWorkspace[]> {
  const result = await listServerRows(
    pairingCode,
    'folderWorkspace.list',
    'folder_workspaces',
    options
  )
  return ServerFolderWorkspacesSchema.parse(result).folderWorkspaces.map(
    ({ id, folderPath, projectGroupId, connectionId, executionHostId }) => ({
      id,
      folderPath,
      projectGroupId,
      ...(connectionId != null ? { connectionId } : {}),
      ...(executionHostId != null ? { executionHostId } : {})
    })
  )
}

/**
 * Incoming folder workspaces the server holds under the same id and folder: its copy from an
 * earlier move. A different folder under that id still imports, so the server refuses it.
 */
export function folderWorkspacesHeldByServer(
  incoming: readonly Pick<FolderWorkspace, 'id' | 'folderPath'>[],
  server: readonly OrcadServerFolderWorkspace[]
): string[] {
  const serverFolderById = new Map(
    server
      .filter(isRepoOnCatalogHost)
      .map((workspace) => [workspace.id, normalizeRuntimePathForComparison(workspace.folderPath)])
  )
  return incoming
    .filter(
      (workspace) =>
        serverFolderById.get(workspace.id) ===
        normalizeRuntimePathForComparison(workspace.folderPath)
    )
    .map((workspace) => workspace.id)
}
