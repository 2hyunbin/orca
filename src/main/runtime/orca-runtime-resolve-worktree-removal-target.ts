// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import type { RuntimeWorkspaceRemovalRecovery } from './workspaces/workspace-removal-recovery'
import { WorkspaceRemovalMetadata } from './workspaces/workspace-removal-metadata'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { RuntimeWorktreeRemovalTarget } from './runtime-worktree-selection'
import { resolveRuntimeWorktreeRemovalTarget } from './runtime-worktree-removal-target'
import type { ForceDeleteWorktreeBranchResult } from '../../shared/worktree/create-types'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import { terminalShellOverrideRefusal } from './terminal-shell-override-host-support'
import { resolveTerminalStartupCwd } from '../../shared/terminal-startup-cwd'
import { resolveLocalProjectRuntimeForWorktreeId } from '../local-project-runtime-resolution'
import { resolveQoderTerminalCommandForWorkspace } from './qoder-terminal-command-resolution'
import { buildRuntimeAgentTerminalStartupOptions } from './runtime-agent-terminal-startup'

export class OrcaRuntimeWithResolveWorktreeRemovalTarget extends WorkspaceRemovalMetadata {
  protected async resolveWorktreeRemovalTarget(
    worktreeSelector: string,
    requiredHostId?: ExecutionHostId
  ): Promise<RuntimeWorktreeRemovalTarget> {
    return resolveRuntimeWorktreeRemovalTarget({
      selector: worktreeSelector,
      store: this.store,
      resolveWorktree: (selector) => this.resolveWorktreeSelector(selector),
      resolveExplicitWorktreeIdScoped: (worktreeId, hostId) =>
        this.resolveExplicitWorktreeIdScoped(worktreeId, hostId),
      ...(requiredHostId ? { requiredHostId } : {})
    })
  }
  finishInterruptedWorktreeRemovals(
    ...args: Parameters<RuntimeWorkspaceRemovalRecovery['finishInterruptedWorktreeRemovals']>
  ): ReturnType<RuntimeWorkspaceRemovalRecovery['finishInterruptedWorktreeRemovals']> {
    return this.workspaceRemovalRecovery.finishInterruptedWorktreeRemovals(...args)
  }

  protected joinPendingWorktreeRemoval(
    ...args: Parameters<RuntimeWorkspaceRemovalRecovery['joinPendingWorktreeRemoval']>
  ): ReturnType<RuntimeWorkspaceRemovalRecovery['joinPendingWorktreeRemoval']> {
    return this.workspaceRemovalRecovery.joinPendingWorktreeRemoval(...args)
  }

  protected retryFailedLocalRemoval(
    ...args: Parameters<RuntimeWorkspaceRemovalRecovery['retryFailedLocalRemoval']>
  ): ReturnType<RuntimeWorkspaceRemovalRecovery['retryFailedLocalRemoval']> {
    return this.workspaceRemovalRecovery.retryFailedLocalRemoval(...args)
  }

  protected localRemovalJobHost(
    ...args: Parameters<RuntimeWorkspaceRemovalRecovery['localRemovalJobHost']>
  ): ReturnType<RuntimeWorkspaceRemovalRecovery['localRemovalJobHost']> {
    return this.workspaceRemovalRecovery.localRemovalJobHost(...args)
  }

  protected purgeRemovedWorktree(
    ...args: Parameters<RuntimeWorkspaceRemovalRecovery['purgeRemovedWorktree']>
  ): ReturnType<RuntimeWorkspaceRemovalRecovery['purgeRemovedWorktree']> {
    return this.workspaceRemovalRecovery.purgeRemovedWorktree(...args)
  }

  // Why: headless offscreen browser pages are main-process BrowserWindows that
  // outlive a worktree unless explicitly closed — removing a worktree without
  // closing its open panes leaks the windows for the life of the serve process.
  protected closeHeadlessBrowserPagesForWorktree(worktreeId: string): void {
    if (!this.offscreenBrowserBackend || !this.agentBrowserBridge?.tabList) {
      return
    }
    for (const tab of this.agentBrowserBridge.tabList(worktreeId).tabs) {
      void this.offscreenBrowserBackend.closeTab(tab.browserPageId).catch(() => {})
    }
  }

  async forceDeletePreservedBranch(
    worktreeSelector: string,
    branchName: string,
    expectedHead: string,
    hostId?: string
  ): Promise<ForceDeleteWorktreeBranchResult> {
    return this.preservedBranchCleanup.forceDelete(
      worktreeSelector,
      branchName,
      expectedHead,
      hostId
    )
  }

  protected async resolveAgentTerminalCreateOptions(
    workspace: TerminalWorkspaceLaunchScope,
    opts: TerminalCreateOptions
  ): Promise<TerminalCreateOptions> {
    const launch = await this.buildAgentTerminalCreateOptions(workspace, opts)
    return resolveQoderTerminalCommandForWorkspace(
      launch,
      workspace,
      this.store,
      this.getAgentLaunchPlatformForWorkspace(workspace)
    )
  }

  protected async buildAgentTerminalCreateOptions(
    workspace: TerminalWorkspaceLaunchScope,
    opts: TerminalCreateOptions
  ): Promise<TerminalCreateOptions> {
    // Before any early return: every create lane funnels through here, and a host that cannot
    // apply the requested shell must refuse rather than spawn its default one.
    const shellRefusal = terminalShellOverrideRefusal({
      shellOverride: opts.shellOverride,
      connectionId: workspace.connectionId,
      platform: process.platform,
      projectRuntime:
        opts.shellOverride && this.store
          ? resolveLocalProjectRuntimeForWorktreeId(this.store, workspace.id)
          : undefined,
      // Same resolution as the spawn lanes below, so the refusal judges the cwd the PTY gets.
      cwd: resolveTerminalStartupCwd(workspace.path, opts.cwd) ?? workspace.path,
      workspacePath: workspace.path
    })
    if (shellRefusal) {
      throw shellRefusal
    }
    // Why: raw shell commands like `codex exec` must remain user-authored shell.
    // Only unmanaged, repo-backed, bare agent launches get Settings defaults.
    const callerSuppliedLaunch =
      opts.env ||
      opts.launchConfig ||
      opts.launchAgent ||
      opts.startupCommandDelivery ||
      opts.claudeAgentTeamsSourceCommand
    const store = this.store
    if (opts.startupAgent) {
      // Why: falling through unresolved would spawn a bare shell that can only time
      // out waiting for an agent. A caller-supplied launch contradicts the agent:
      // `command` would be overwritten, `resumeProviderSession` would pair resume
      // identity with a fresh launch.
      if (callerSuppliedLaunch || opts.command || opts.resumeProviderSession) {
        throw new Error(
          `startupAgent ${opts.startupAgent} cannot combine with a caller-supplied launch.`
        )
      }
      if (!store) {
        throw new Error('runtime_unavailable')
      }
    } else if (callerSuppliedLaunch || !store || !opts.command || !workspace.repo) {
      return opts
    }

    return buildRuntimeAgentTerminalStartupOptions(
      workspace,
      opts,
      store.getSettings(),
      this.getAgentLaunchPlatformForWorkspace(workspace),
      this.toAgentSessionOptions(opts.launchPreferences),
      this.runtimeId
    )
  }
}
