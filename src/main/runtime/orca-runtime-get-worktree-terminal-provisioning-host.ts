import { OrcaRuntimeWithActivateManagedWorktree } from './orca-runtime-activate-managed-worktree'
import type { WorktreeTerminalProvisioningHost } from './runtime-worktree-terminal-provisioning'
import type { WorktreeStartupReadinessHost } from './runtime-worktree-startup-readiness'
import { prefetchWorktreeCreateBase } from '../worktree-create-base-prefetch'
import { prepareWorktreeCreateForRepo } from '../worktree-create-preparation'
import { getWorktreeCreatePrefetchGitOptions } from '../project-runtime-git-options'
import type { Worktree } from '../../shared/worktree/types'
import {
  navigationTargetsHost,
  type RuntimeNavigationTarget
} from '../../shared/runtime-navigation'
import type { OrcaRuntimeWithTerminalCreateDeduplication } from './orca-runtime-terminal-create-deduplication'
import type { RuntimeWorkspaceQuerySurface } from './workspaces/workspace-query-surface'
import type { RuntimeWorkspaceMetadataSurface } from './workspaces/workspace-metadata-surface'

export abstract class OrcaRuntimeWithGetWorktreeTerminalProvisioningHost extends OrcaRuntimeWithActivateManagedWorktree {
  public abstract createTerminal(
    ...args: Parameters<OrcaRuntimeWithTerminalCreateDeduplication['createTerminal']>
  ): ReturnType<OrcaRuntimeWithTerminalCreateDeduplication['createTerminal']>

  public abstract splitTerminal(
    ...args: Parameters<OrcaRuntimeWithTerminalCreateDeduplication['splitTerminal']>
  ): ReturnType<OrcaRuntimeWithTerminalCreateDeduplication['splitTerminal']>

  protected abstract requireStore(
    ...args: Parameters<RuntimeWorkspaceQuerySurface['requireStore']>
  ): ReturnType<RuntimeWorkspaceQuerySurface['requireStore']>

  protected abstract resolveRepoSelector(
    ...args: Parameters<RuntimeWorkspaceQuerySurface['resolveRepoSelector']>
  ): ReturnType<RuntimeWorkspaceQuerySurface['resolveRepoSelector']>

  public abstract resolveRemoteTrackingBase(
    ...args: Parameters<RuntimeWorkspaceMetadataSurface['resolveRemoteTrackingBase']>
  ): ReturnType<RuntimeWorkspaceMetadataSurface['resolveRemoteTrackingBase']>

  public abstract hasRemoteTrackingRef(
    ...args: Parameters<RuntimeWorkspaceMetadataSurface['hasRemoteTrackingRef']>
  ): ReturnType<RuntimeWorkspaceMetadataSurface['hasRemoteTrackingRef']>

  public abstract getOrStartRemoteTrackingBaseRefresh(
    ...args: Parameters<RuntimeWorkspaceMetadataSurface['getOrStartRemoteTrackingBaseRefresh']>
  ): ReturnType<RuntimeWorkspaceMetadataSurface['getOrStartRemoteTrackingBaseRefresh']>

  public abstract fetchRemoteWithCache(
    ...args: Parameters<RuntimeWorkspaceMetadataSurface['fetchRemoteWithCache']>
  ): ReturnType<RuntimeWorkspaceMetadataSurface['fetchRemoteWithCache']>

  protected shouldProvisionWorktreeInBackground(navigation?: RuntimeNavigationTarget): boolean {
    return (
      navigationTargetsHost(navigation ?? 'host') &&
      (!this.notifier || this.graphStatus !== 'ready' || !this.getAvailableAuthoritativeWindow())
    )
  }

  protected getWorktreeTerminalProvisioningHost(
    createdWorktree?: Worktree
  ): WorktreeTerminalProvisioningHost {
    return {
      canSpawn: () => Boolean(this.ptyController?.spawn),
      createTerminal: (selector, options) =>
        this.createTerminal(selector, options, createdWorktree),
      splitTerminal: (handle, options) => this.splitTerminal(handle, options, createdWorktree),
      setTabTitle: async (handle, title) => {
        const { worktreeId, tabId } = this.getProvisionedTerminalTab(handle)
        // Why not renameTerminal: it writes the pane's title, stamped to outrank every later
        // agent title, which would hide the agent's own titles and status for the pane's life.
        this.notifier?.renameTerminal(tabId, title, { recordInteraction: false })
        if (!this.getAvailableAuthoritativeWindow()) {
          this.persistHeadlessTerminalTitle(worktreeId, tabId, title)
          this.applyHeadlessSessionTabPropsToSnapshot(worktreeId, tabId, { title })
        }
      },
      setTabColor: async (handle, color) => {
        const { worktreeId, tabId } = this.getProvisionedTerminalTab(handle)
        await this.setMobileSessionTabProps(`id:${worktreeId}`, { tabId, color })
      },
      getSettings: () => this.requireStore().getSettings(),
      getPtyId: (handle) => this.getLivePtyForHandle(handle)?.pty.ptyId,
      recordSetupCompletionToken: (ptyId, token) =>
        this.setupCompletionTokenByPtyId.set(ptyId, token)
    }
  }

  protected getProvisionedTerminalTab(handle: string): { worktreeId: string; tabId: string } {
    const pty = this.getLivePtyForHandle(handle)?.pty
    if (pty?.tabId) {
      return { worktreeId: pty.worktreeId, tabId: pty.tabId }
    }
    // Why: once the window's graph sync adopts the handle it names the window's leaf, not the
    // runtime's pty, as renameTerminal also resolves it.
    const { leaf } = this.getLiveLeafForHandle(handle)
    return { worktreeId: leaf.worktreeId, tabId: leaf.tabId }
  }

  protected getWorktreeStartupReadinessHost(): WorktreeStartupReadinessHost {
    return {
      getPtyId: (handle) => this.getLivePtyForHandle(handle)?.pty.ptyId ?? null,
      getForegroundProcess: (ptyId) => this.ptyController!.getForegroundProcess(ptyId),
      hasChildProcesses: (ptyId) =>
        this.ptyController!.hasChildProcesses?.(ptyId) ?? Promise.resolve(false),
      subscribeToData: (ptyId, listener) => this.subscribeToTerminalData(ptyId, listener),
      readRecentOutput: (ptyId) => this.recentPtyOutputById.get(ptyId)?.read(),
      write: (ptyId, data, inputKind) => this.ptyController?.write(ptyId, data, inputKind)
    }
  }

  async prefetchManagedWorktreeCreateBase(args: {
    repoSelector: string
    baseBranch?: string
  }): Promise<void> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }

    const repo = await this.resolveRepoSelector(args.repoSelector)
    const store = this.requireStore()
    await prefetchWorktreeCreateBase({
      repo,
      baseBranch: args.baseBranch,
      runtime: this,
      gitOptions: getWorktreeCreatePrefetchGitOptions(store, repo),
      prepareCheckout: (base, beforeMaterialization) =>
        prepareWorktreeCreateForRepo(store, repo, base, beforeMaterialization)
    })
  }
}
