import {
  findWorkspaceFileRoute,
  type RuntimeWorkspaceFileRoute
} from '@/lib/runtime-workspace-file-route'
import { useAppStore } from '@/store'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { isFloatingWorkspaceId } from '../../../../shared/floating-workspace-worktree'
import type { HostWorkspaceFile } from './terminal-host-workspace-file'

/**
 * Another workspace on the same host that holds a link's path. The link still opens in the
 * workspace it was clicked in (#32158); this names the owner for the read and the hint.
 */
export function otherWorkspaceFileOwner(
  executionHostId: ExecutionHostId,
  absolutePath: string,
  sourceWorktreeId: string
): RuntimeWorkspaceFileRoute | null {
  // Why: floating-workspace files stay in their panel even when a project also contains the path.
  if (isFloatingWorkspaceId(sourceWorktreeId)) {
    return null
  }
  const owner = findWorkspaceFileRoute(useAppStore.getState(), executionHostId, absolutePath)
  return owner && owner.worktreeId !== sourceWorktreeId ? owner : null
}

/**
 * A link to a file another workspace on this computer or server holds is viewed here. A direct
 * SSH connection has no such view (a read-only absolute tab there reads as this computer's file),
 * so its file still opens in the owning workspace, which also reuses a tab already open there.
 */
export function siblingWorkspaceLink(
  executionHostId: ExecutionHostId,
  absolutePath: string,
  sourceWorktreeId: string
): { view: RuntimeWorkspaceFileRoute | null; openInOwner: RuntimeWorkspaceFileRoute | null } {
  const owner = otherWorkspaceFileOwner(executionHostId, absolutePath, sourceWorktreeId)
  return parseExecutionHostId(executionHostId)?.kind === 'ssh'
    ? { view: null, openInOwner: owner }
    : { view: owner, openInOwner: null }
}

/**
 * A paired or managed host named another workspace for the link: viewable here only when this
 * client's catalog agrees, since the editor reads it through that workspace's scope on the host.
 */
export function hostNamedOtherWorkspaceOwner(
  linkOwner: HostWorkspaceFile,
  sourceWorktreeId: string
): RuntimeWorkspaceFileRoute | null {
  if (linkOwner.isDirectory) {
    return null
  }
  const owner = otherWorkspaceFileOwner(
    linkOwner.executionHostId,
    linkOwner.absolutePath,
    sourceWorktreeId
  )
  return owner?.worktreeId === linkOwner.worktreeId ? owner : null
}

/** A view here of the owner's file: stamped with its host and never saved here. */
export function otherWorkspaceViewFields(
  owner: RuntimeWorkspaceFileRoute | null,
  runtimeEnvironmentId: string | null
): { readOnly?: true; runtimeEnvironmentId?: string | null } {
  return owner ? { readOnly: true, runtimeEnvironmentId } : {}
}
