// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import type { RuntimeWorkspaceRemovalRecovery } from './workspaces/workspace-removal-recovery'
import { RuntimeWorkspaceRemovalSurface } from './workspaces/workspace-removal-surface'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { RuntimeWorktreeRemovalTarget } from './runtime-worktree-selection'
import { resolveRuntimeWorktreeRemovalTarget } from './runtime-worktree-removal-target'
import type { RuntimeStore } from './runtime-store-contract'
import { splitWorktreeId } from '../../shared/worktree/id'
import { runtimeWorktreeIdsEqual } from './runtime-worktree-path-identity'
import { hasWorktreeRemovalRepoOwnerOnOtherHost } from '../worktree-removal-repo-owner'
import { advertisedUrlWatcher } from '../ports/advertised-url-watcher'
import { deleteWorktreeHistoryDir } from '../terminal-history-deletion'
import { closeClientHostedBrowserPagesForWorktree } from './worktree-browser-client-page-close'
import type { ForceDeleteWorktreeBranchResult } from '../../shared/worktree/create-types'
import type { RuntimeTerminalRename } from '../../shared/runtime-types'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import { terminalShellOverrideRefusal } from './terminal-shell-override-host-support'
import { resolveTerminalStartupCwd } from '../../shared/terminal-startup-cwd'
import { resolveLocalProjectRuntimeForWorktreeId } from '../local-project-runtime-resolution'
import { resolveQoderTerminalCommandForWorkspace } from './qoder-terminal-command-resolution'
import { buildRuntimeAgentTerminalStartupOptions } from './runtime-agent-terminal-startup'

export class OrcaRuntimeWithResolveWorktreeRemovalTarget extends RuntimeWorkspaceRemovalSurface {
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

  protected removeWorktreeMetadataAndHistory(
    store: RuntimeStore,
    worktreeId: string,
    hostId?: ExecutionHostId
  ): void {
    // Why: worktree IDs are path-derived and can be recreated, so removal must
    // purge history and process-local caches before the ID points at new state.
    const persistedHostId = store.getWorktreeMeta(worktreeId)?.hostId
    const repoId = splitWorktreeId(worktreeId)?.repoId
    const preservesSameIdOwner = Boolean(
      hostId &&
      ((persistedHostId && persistedHostId !== hostId) ||
        (repoId && hasWorktreeRemovalRepoOwnerOnOtherHost(store, repoId, hostId)))
    )
    const acceptedRendererSnapshot = this.acceptedRendererMobileSnapshotByWorktree.get(worktreeId)
    const storedSnapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (hostId) {
      store.removeWorktreeMeta(worktreeId, hostId)
    } else {
      store.removeWorktreeMeta(worktreeId)
    }
    // Why outside the same-id gate: retirement is per host and per pane, so a surviving owner keeps its own.
    this.dropAgentStatusForRemovedWorktreeFn?.(worktreeId, hostId ?? persistedHostId)
    if (!preservesSameIdOwner) {
      // A paired PTY can outlive the delete acknowledgement; it must not be
      // rescued into a newly-created occupant of the same path-derived ID.
      for (const ptyId of this.pairedRendererSessionOwnedPtyIds) {
        const ptyWorktreeId = this.ptysById.get(ptyId)?.worktreeId
        if (ptyWorktreeId && runtimeWorktreeIdsEqual(ptyWorktreeId, worktreeId)) {
          this.pairedRendererSessionOwnedPtyIds.delete(ptyId)
        }
      }
      const removedPublicationEpoch =
        acceptedRendererSnapshot?.publicationEpoch ??
        storedSnapshot?.publicationEpoch ??
        this.rendererGeneration ??
        undefined
      this.removedMobileSessionWorktreeIds.set(
        worktreeId,
        removedPublicationEpoch ? { removedPublicationEpoch } : {}
      )
      this.mobileSessionTabsByWorktree.delete(worktreeId)
      this.mobileSessionTabsAgentStatusHeartbeat.removeWorktree(worktreeId)
      this.acceptedRendererMobileSnapshotByWorktree.delete(worktreeId)
      this.cancelScheduledMobileSessionTabsChanged(worktreeId)
      this.notifyMobileSessionTabsRemoved(worktreeId)
      advertisedUrlWatcher.forgetWorktree(worktreeId)
      deleteWorktreeHistoryDir(worktreeId)
      this.closeHeadlessBrowserPagesForWorktree(worktreeId)
      closeClientHostedBrowserPagesForWorktree(this, worktreeId)
    }
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

  async renameTerminal(handle: string, title: string | null): Promise<RuntimeTerminalRename> {
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      pty.pty.title = title
      // Why: a manual rename must outrank later agent OSC title updates (which
      // win by timestamp), so stamp it as the freshest title.
      pty.pty.titleUpdatedAt = Date.now()
      this.touchMobileSessionSnapshotsForPty(pty.pty.ptyId)
      // Why: without a renderer the rename only lived on the live pty and was
      // lost on restart. Persist customTitle so a headless rebuild keeps it.
      if (!this.notifier?.renameTerminal && pty.pty.tabId) {
        this.persistHeadlessTerminalTitle(pty.pty.worktreeId, pty.pty.tabId, title)
      }
      for (const leaf of this.leaves.values()) {
        if (leaf.ptyId === pty.pty.ptyId) {
          this.notifier?.renameTerminal(leaf.tabId, title)
          return { handle, tabId: leaf.tabId, title }
        }
      }
      const tabId = pty.pty.tabId ?? pty.record.tabId
      // A notifier can exist before its pane graph; retain the rename on the known tab.
      if (this.notifier?.renameTerminal && tabId) {
        this.persistHeadlessTerminalTitle(pty.pty.worktreeId, tabId, title)
        this.notifier.renameTerminal(tabId, title)
      }
      return { handle, tabId, title }
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    this.notifier?.renameTerminal(leaf.tabId, title)
    return { handle, tabId: leaf.tabId, title }
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
