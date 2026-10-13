import { posix, win32 } from 'node:path'
import {
  isPathInsideOrEqual,
  isRuntimePathAbsolute,
  isWindowsAbsolutePathLike
} from '../../shared/cross-platform-path'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../shared/workspace-scope'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { parseExecutionHostId } from '../../shared/execution-host'
import {
  PluginViewerDocumentError,
  type PluginViewerDocumentInfo
} from '../../shared/plugins/plugin-viewer-document'
import type { PluginViewerDocumentOwner } from '../../shared/plugins/plugin-viewer-document-registry'
import {
  openPluginViewerFileResource,
  type PluginViewerFileRequest,
  type PluginViewerFileResource
} from '../../shared/plugins/plugin-viewer-file-resource'
import type { PluginViewerRuntimeOpen } from '../../shared/plugins/plugin-viewer-runtime-document'
import type { RuntimeFileCommandHost } from './runtime-file-command-host'
import {
  runtimeViewerWorkspaceOwnership,
  type RuntimeViewerWorkspaceCatalog
} from './runtime-plugin-viewer-workspace-ownership'
import { assertRuntimeViewerGitWorktree } from './runtime-plugin-viewer-worktree-authority'

export type RuntimeViewerFileHost = Pick<
  RuntimeFileCommandHost,
  'getRuntimeId' | 'resolveRuntimeFileTarget'
> & {
  requireStore(): RuntimeViewerWorkspaceCatalog
  resolveRuntimeGitTarget?: RuntimeFileCommandHost['resolveRuntimeGitTarget']
}

export type RuntimeViewerFileRoute = {
  owner: PluginViewerDocumentOwner
  file: PluginViewerFileRequest
  document?: PluginViewerDocumentInfo
  isCurrent(): Promise<boolean>
  openFile(signal: AbortSignal): Promise<PluginViewerFileResource>
  onInvalidated(listener: () => void): () => void
  release?(): void
}

export async function resolveRuntimePluginViewerFileRoute(
  host: RuntimeViewerFileHost,
  input: PluginViewerRuntimeOpen,
  clientId: string,
  isLive: () => boolean,
  selection?: { kind: 'host-selected-file' }
): Promise<RuntimeViewerFileRoute> {
  const workspaceId = normalizeWorkspaceSessionKeyToWorkspaceId(input.owner.workspaceId)
  const worktreeId = splitWorktreeIdForFilesystem(workspaceId)
  if (
    workspaceId === 'folder:' ||
    (!workspaceId.startsWith('folder:') &&
      (!worktreeId?.repoId || !isRuntimePathAbsolute(worktreeId.worktreePath)))
  ) {
    throw new PluginViewerDocumentError('unauthorized')
  }
  const selector = workspaceId.startsWith('folder:') ? workspaceId : `id:${workspaceId}`
  const target = await host.resolveRuntimeFileTarget(selector)
  const root = target.worktree.path
  const executionHostId = target.executionHostId
  const ownership = runtimeViewerWorkspaceOwnership(host.requireStore(), target)
  const hostIdentity = parseExecutionHostId(executionHostId)
  if (!hostIdentity || hostIdentity.id !== executionHostId) {
    throw new PluginViewerDocumentError('unauthorized')
  }
  if (hostIdentity.kind !== 'local') {
    throw new PluginViewerDocumentError('unsupported_host')
  }
  if (
    host.getRuntimeId() !== input.runtimeId ||
    !ownership ||
    target.worktree.id !== workspaceId ||
    !isRuntimePathAbsolute(root) ||
    !isRuntimePathAbsolute(input.filePath)
  ) {
    throw new PluginViewerDocumentError('unauthorized')
  }
  const path = isWindowsAbsolutePathLike(root) ? win32 : posix
  if (
    isWindowsAbsolutePathLike(root) !== isWindowsAbsolutePathLike(input.filePath) ||
    (!selection && !isPathInsideOrEqual(path.normalize(root), path.normalize(input.filePath)))
  ) {
    throw new PluginViewerDocumentError('unauthorized')
  }
  await assertRuntimeViewerGitWorktree(host, target, selector)
  const owner = Object.freeze({
    ...input.owner,
    executionHostId,
    workspaceId,
    clientId
  })
  const file = Object.freeze({
    boundaryPath: selection ? path.dirname(input.filePath) : root,
    entryPath: input.filePath
  })
  return {
    owner,
    file,
    async isCurrent() {
      if (!isLive() || host.getRuntimeId() !== input.runtimeId) {
        return false
      }
      try {
        const current = await host.resolveRuntimeFileTarget(selector)
        return (
          isLive() &&
          host.getRuntimeId() === input.runtimeId &&
          current.worktree.id === workspaceId &&
          runtimeViewerWorkspaceOwnership(host.requireStore(), current) === ownership &&
          current.worktree.path === root &&
          current.executionHostId === executionHostId
        )
      } catch {
        return false
      }
    },
    openFile: (signal) => openPluginViewerFileResource(file, signal),
    onInvalidated: () => () => {}
  }
}
