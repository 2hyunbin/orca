import { isVsCodeRemoteSshCommand } from '../../../shared/vscode-remote-ssh-launcher'
import { isRuntimeOwnedSshTargetId, toRuntimeExecutionHostId } from '../../../shared/execution-host'
import {
  getRuntimeSshAccess,
  type PublicKnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import { getWindowsPathAccess } from './windows-path-access'

export type ExternalEditorOpenCapability =
  | {
      allowed: true
      remote: boolean
      wsl?: true
      /** SSH host a server's files open through, when that server owns the path. */
      sshTargetId?: string
    }
  | { allowed: false; reason: 'remote-runtime' | 'local-only-editor' }

export type ExternalEditorOpenEnvironment = Pick<
  PublicKnownRuntimeEnvironment,
  'id' | 'orcadDeployment' | 'sshAccess'
>

/** The SSH host a server runs on when Orca reaches it through one; null for a network-paired one. */
export function getRuntimeEnvironmentEditorSshTargetId(
  runtimeEnvironmentId: string,
  environments: readonly ExternalEditorOpenEnvironment[] | undefined
): string | null {
  const environment = environments?.find((entry) => entry.id === runtimeEnvironmentId)
  const targetId = environment ? getRuntimeSshAccess(environment)?.sshTargetId : undefined
  // Why: an ephemeral VM's target is an implementation detail, not a host the user's editor knows.
  return targetId && !isRuntimeOwnedSshTargetId(targetId) ? targetId : null
}

export function getExternalEditorOpenCapability(context: {
  connectionId?: string | null
  command?: string
  runtimeEnvironmentId?: string | null
  /** The path's owner could not be placed; a null runtime then proves nothing about locality. */
  ownerUnresolved?: boolean
  environments?: readonly ExternalEditorOpenEnvironment[]
}): ExternalEditorOpenCapability {
  const runtimeEnvironmentId = context.runtimeEnvironmentId?.trim()
  if (context.ownerUnresolved) {
    return { allowed: false, reason: 'remote-runtime' }
  }
  if (runtimeEnvironmentId) {
    // Why: a WSL host's files open from Windows; main sends VS Code and Cursor `--remote wsl+`.
    if (getWindowsPathAccess(toRuntimeExecutionHostId(runtimeEnvironmentId))) {
      return { allowed: true, remote: false, wsl: true }
    }
    // Why: a server on an SSH host keeps its files there, so VS Code Remote-SSH reaches them.
    const sshTargetId = getRuntimeEnvironmentEditorSshTargetId(
      runtimeEnvironmentId,
      context.environments
    )
    if (!sshTargetId) {
      return { allowed: false, reason: 'remote-runtime' }
    }
    return isVsCodeRemoteSshCommand(context.command)
      ? { allowed: true, remote: true, sshTargetId }
      : { allowed: false, reason: 'local-only-editor' }
  }
  if (!context.connectionId?.trim()) {
    return { allowed: true, remote: false }
  }
  return isVsCodeRemoteSshCommand(context.command)
    ? { allowed: true, remote: true }
    : { allowed: false, reason: 'local-only-editor' }
}
