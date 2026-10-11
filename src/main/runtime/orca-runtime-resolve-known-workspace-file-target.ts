// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithPersistHeadlessTerminalTitle } from './orca-runtime-persist-headless-terminal-title'
import {
  getConnectionExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { resolveWorktreeHostRouting } from './worktree-launch-host-repo'
import { findRuntimeWorkspaceFileOwner } from '../../shared/runtime-workspace-file-owner'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'

import type { PtyIncarnationId } from '../../shared/pty-incarnation'

export class OrcaRuntimeWithResolveKnownWorkspaceFileTarget extends OrcaRuntimeWithPersistHeadlessTerminalTitle {
  protected async resolveKnownWorkspaceFileTarget(
    absolutePath: string,
    executionHostId: ExecutionHostId
  ): Promise<{
    worktree: ResolvedWorktree
    executionHostId: ExecutionHostId
    relativePath: string
  } | null> {
    const targets = new Map<
      string,
      { worktree: ResolvedWorktree; executionHostId: ExecutionHostId }
    >()
    const repos = this.store?.getRepos() ?? []
    const resolvedWorktrees = await this.listResolvedWorktrees()
    const visibilitySourceMatchersByRepoId =
      this.buildRuntimeVisibilitySourceMatchersByRepoId(resolvedWorktrees)
    for (const worktree of resolvedWorktrees) {
      if (
        !this.isRuntimeWorktreeVisible(
          worktree,
          visibilitySourceMatchersByRepoId.get(worktree.repoId)
        )
      ) {
        continue
      }
      // Why: `getRepo(id)` is host-blind, so a candidate on one SSH host could be filed under
      // another's key and then answer for a path it does not hold. Rival rows that disagree with
      // no worktree host name no single filesystem authority, so that candidate is dropped.
      const routing = resolveWorktreeHostRouting(repos, worktree)
      if (routing.kind === 'ambiguous') {
        continue
      }
      const target = {
        worktree,
        executionHostId: routing.kind === 'resolved' ? routing.hostId : LOCAL_EXECUTION_HOST_ID
      }
      targets.set(`${target.executionHostId}\0${worktree.id}`, target)
    }
    for (const folderWorkspace of this.store?.getFolderWorkspaces?.() ?? []) {
      try {
        const candidateConnectionId = this.resolveFolderWorkspaceConnectionId(folderWorkspace)
        const worktree = this.folderWorkspaceToResolvedWorktree(folderWorkspace)
        const target = {
          worktree,
          executionHostId: getConnectionExecutionHostId(candidateConnectionId)
        }
        targets.set(`${target.executionHostId}\0${worktree.id}`, target)
      } catch {
        // An ambiguous folder workspace has no single filesystem authority.
      }
    }

    const owner = findRuntimeWorkspaceFileOwner(
      [...targets.values()].map((target) => ({
        workspaceId: target.worktree.id,
        rootPath: target.worktree.path,
        executionHostId: target.executionHostId
      })),
      absolutePath,
      executionHostId
    )
    if (!owner) {
      return null
    }
    const target = targets.get(`${owner.executionHostId}\0${owner.workspaceId}`)
    return target ? { ...target, relativePath: owner.relativePath } : null
  }

  onMobileSessionTabsChanged(
    listener: (snapshot: RuntimeMobileSessionTabsResult, changeSequence: number) => void,
    clientNavigationId?: string
  ): () => void {
    // Why: a notify coalesced before this subscriber existed is already folded
    // into the initial snapshot it was just sent. Draining it here — before the
    // listener joins — keeps that pending timer from landing as a redundant
    // `updated` frame carrying pre-subscribe state. Mirrors the unsubscribe flush.
    this.mobileSessionTabsNotifyCoalescer.flushAll()
    const subscription = { listener, clientNavigationId }
    this.mobileSessionTabListeners.add(subscription)
    return () => {
      // Why: flush pending coalesced notifies before dropping this listener so a
      // subscriber closing mid-window still receives the latest settled state.
      this.mobileSessionTabsNotifyCoalescer.flushAll()
      this.mobileSessionTabListeners.delete(subscription)
      if (this.mobileSessionTabListeners.size === 0) {
        this.mobileSessionTabsAgentStatusHeartbeat.cancelPending()
      }
    }
  }

  forgetClientNavigationState(clientNavigationId: string): void {
    this.clientSessionTabSelections.forgetClient(clientNavigationId)
  }

  // Why: terminal handles are normally created lazily when first referenced via
  // RPC, but agents need their own handle at spawn time (via ORCA_TERMINAL_HANDLE
  // env var) so they can self-identify in orchestration messages without an
  // extra RPC round-trip. Pre-allocating by ptyId lets issueHandle reuse it.
  preAllocateHandleForPty(ptyId: string): string {
    return this.terminalIdentity.preAllocateHandleForPty(ptyId)
  }

  createPreAllocatedTerminalHandle(): string {
    return this.terminalIdentity.createPreAllocatedTerminalHandle()
  }

  protected rememberPtyHandleReplacementFence(
    ptyId: string,
    incarnationId: PtyIncarnationId,
    staleHandles: Iterable<string>,
    pendingRegistration: boolean
  ): void {
    return this.terminalIdentity.rememberPtyHandleReplacementFence(
      ptyId,
      incarnationId,
      staleHandles,
      pendingRegistration
    )
  }

  registerPreAllocatedHandleForPty(ptyId: string, handle: string): void {
    return this.terminalIdentity.registerPreAllocatedHandleForPty(ptyId, handle)
  }

  protected adoptControllerTerminalHandle(
    ptyId: string,
    handle: string | undefined,
    incarnationId?: string,
    options: { exactRestoredSurface?: boolean } = {}
  ): void {
    return this.terminalIdentity.adoptControllerTerminalHandle(
      ptyId,
      handle,
      incarnationId,
      options
    )
  }
}
