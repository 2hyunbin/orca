import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { resolveWindowsShellOverride } from '@/lib/pane-manager/windows-pty-compatibility'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { isWslUncPath } from '../../../shared/wsl-paths'
import {
  canonicalizeWindowsShellOverride,
  resolveLocalWindowsAgentStartupShell,
  resolveWindowsShellStartupFamily
} from '../../../shared/windows-terminal-shell'
import type { ExecutionHostPlatformFact } from './execution-host-facts'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type { AgentStartupShell } from '../../../shared/tui-agent-startup-shell'

export type AgentResumeLaunchTarget = {
  platform: NodeJS.Platform
  /** undefined keeps the platform default: PowerShell on win32, POSIX elsewhere. */
  shell: AgentStartupShell | undefined
}

export type AgentResumeLaunchTargetArgs = {
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
  /** SSH connection owning the workspace, if any. */
  connectionId: string | null | undefined
  /** Pane/workspace execution owner; only a 'local' host is the one `terminalWindowsShell` describes. */
  executionHostId: string | null
  worktreePath: string | null | undefined
  terminalWindowsShell: string | null | undefined
  /** Per-tab Windows shell override, which beats the global setting at spawn time. */
  tabShellOverride?: string | null
  /** OS a non-local execution host reported; null/undefined when unknown. */
  remotePlatform?: NodeJS.Platform | null
}

function isRemoteResumeTarget(args: AgentResumeLaunchTargetArgs): boolean {
  return Boolean(args.connectionId) || parseExecutionHostId(args.executionHostId)?.kind !== 'local'
}

/** The reported OS of a non-local host, or null for a local or not-yet-reported host. */
export function remotePlatformFromHostFact(
  fact: ExecutionHostPlatformFact
): NodeJS.Platform | null {
  return fact.kind === 'known' && fact.hostKind !== 'local' ? fact.platform : null
}

function resolveResumeLaunchPlatform(args: AgentResumeLaunchTargetArgs): NodeJS.Platform {
  if (args.projectRuntime?.status === 'repair-required') {
    return args.projectRuntime.repair.preferredRuntime.kind === 'wsl' ? 'linux' : CLIENT_PLATFORM
  }
  if (args.projectRuntime?.status === 'resolved' && args.projectRuntime.runtime.kind === 'wsl') {
    return 'linux'
  }
  if (args.remotePlatform && isRemoteResumeTarget(args)) {
    return args.remotePlatform
  }
  if (args.connectionId || (args.worktreePath && isWslUncPath(args.worktreePath))) {
    return 'linux'
  }
  return CLIENT_PLATFORM
}

/**
 * Platform *and* live shell family a queued agent-resume command must be quoted for.
 * Why the shell half matters: resume lines are typed into a real terminal, so on a
 * cmd.exe tab the win32 PowerShell default sends literal quotes and the agent CLI
 * rejects the resume argv ("unexpected argument ''<uuid>'' found", #12320).
 */
export function resolveAgentResumeLaunchTarget(
  args: AgentResumeLaunchTargetArgs
): AgentResumeLaunchTarget {
  const platform = resolveResumeLaunchPlatform(args)
  const isRemote = isRemoteResumeTarget(args)
  if (isRemote && platform === 'win32' && args.remotePlatform === 'win32') {
    // Why: the client's Windows shell setting doesn't describe a remote host, but a remote tab's
    // own shell override is what the host spawned, so cmd.exe tabs need cmd quoting.
    const override = args.tabShellOverride
      ? canonicalizeWindowsShellOverride(args.tabShellOverride.trim())
      : undefined
    return {
      platform,
      shell: override ? resolveWindowsShellStartupFamily(override) : undefined
    }
  }
  return {
    platform,
    shell: resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote,
      terminalWindowsShell: resolveWindowsShellOverride(
        args.tabShellOverride,
        args.terminalWindowsShell
      )
    })
  }
}
