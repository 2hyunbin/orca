import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { PluginViewerDocumentError } from '../../shared/plugins/plugin-viewer-document'
import { listWorktreesStrict } from '../git/worktree'
import type { ResolvedRuntimeFileTarget } from './runtime-file-command-target'
import type { RuntimeViewerFileHost } from './runtime-plugin-viewer-file-route'
import { resolveWorktreeHostRouting } from './worktree-launch-host-repo'

export async function assertRuntimeViewerGitWorktree(
  host: RuntimeViewerFileHost,
  target: ResolvedRuntimeFileTarget,
  selector: string
): Promise<void> {
  if (target.worktree.id.startsWith('folder:')) {
    return
  }
  const routing = resolveWorktreeHostRouting(host.requireStore().getRepos(), target.worktree)
  if (routing.kind !== 'resolved' || !routing.repo || routing.hostId !== target.executionHostId) {
    throw new PluginViewerDocumentError('unauthorized')
  }
  if (routing.repo.kind === 'folder') {
    return
  }
  if (!host.resolveRuntimeGitTarget) {
    throw new PluginViewerDocumentError('unavailable')
  }
  const gitTarget = await host.resolveRuntimeGitTarget(selector)
  if (
    gitTarget.executionHostId !== 'local' ||
    gitTarget.executionHostId !== target.executionHostId ||
    gitTarget.worktree.id !== target.worktree.id ||
    gitTarget.worktree.path !== target.worktree.path
  ) {
    throw new PluginViewerDocumentError('unauthorized')
  }
  // Degraded discovery can return saved rows; opening bytes requires Git's current registration.
  const listed = await listWorktreesStrict(routing.repo.path, gitTarget.localGitOptions).catch(
    () => {
      throw new PluginViewerDocumentError('unavailable')
    }
  )
  if (
    !listed.some(
      (row) =>
        normalizeRuntimePathForComparison(row.path) ===
        normalizeRuntimePathForComparison(target.worktree.path)
    )
  ) {
    throw new PluginViewerDocumentError('unauthorized')
  }
}
