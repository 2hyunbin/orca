// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithCloseHeadlessMobileTerminalTab } from './orca-runtime-close-headless-mobile-terminal-tab'
import type {
  RuntimeMarkdownReadTabResult,
  RuntimeMarkdownSaveTabResult
} from '../../shared/runtime-types'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { Repo } from '../../shared/repo-types'
import {
  getConnectionExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../shared/execution-host'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { resolveWorktreeHostRouting } from './worktree-launch-host-repo'
import { isFloatingWorkspaceSelector } from '../../shared/floating-workspace-worktree'

export class OrcaRuntimeWithPersistHeadlessTerminalTitle extends OrcaRuntimeWithCloseHeadlessMobileTerminalTab {
  // Persist a manual terminal rename so a headless rebuild keeps the title
  // instead of reverting to the generated/default one.
  protected persistHeadlessTerminalTitle(tabId: string, title: string | null): void {
    this.paneTitleFacts.setCustomTitle(tabId, title)
  }

  async readMobileMarkdownTab(
    worktreeSelector: string,
    tabId: string
  ): Promise<RuntimeMarkdownReadTabResult> {
    const worktreeId = await this.resolveMobileMarkdownWorktreeId(worktreeSelector, tabId)
    if (!this.notifier?.readMobileMarkdownTab) {
      throw new Error('renderer_unavailable')
    }
    return await this.notifier.readMobileMarkdownTab(worktreeId, tabId)
  }

  async saveMobileMarkdownTab(
    worktreeSelector: string,
    tabId: string,
    baseVersion: string,
    content: string
  ): Promise<RuntimeMarkdownSaveTabResult> {
    const worktreeId = await this.resolveMobileMarkdownWorktreeId(worktreeSelector, tabId)
    if (!this.notifier?.saveMobileMarkdownTab) {
      throw new Error('renderer_unavailable')
    }
    return await this.notifier.saveMobileMarkdownTab(worktreeId, tabId, baseVersion, content)
  }

  // Why: `getRepo(id)` is host-blind and never read `worktree.hostId`, which outranks every repo
  // row. One id can name rows on local, SSH and runtime hosts at once, so an arbitrary row decided
  // the execution host for ~36 downstream Git dispatches: a worktree on one SSH host routed to
  // another, and a runtime host's *nested* target got dialled in this client's namespace (#11163).
  protected async resolveRuntimeGitTarget(worktreeSelector: string): Promise<{
    worktree: ResolvedWorktree
    repo?: Repo
    executionHostId: ExecutionHostId
    localGitOptions?: { wslDistro?: string }
  }> {
    const store = this.requireStore()
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const routing = resolveWorktreeHostRouting(store.getRepos(), worktree)
    if (routing.kind === 'ambiguous') {
      throw new Error('worktree_execution_host_unresolved')
    }
    const executionHostId = routing.kind === 'resolved' ? routing.hostId : LOCAL_EXECUTION_HOST_ID
    // Metadata only (shared-link paths, source-control AI defaults); routing is `executionHostId`.
    const repo =
      (routing.kind === 'resolved' ? routing.repo : null) ?? store.getRepo(worktree.repoId)
    const localGitOptions =
      repo && executionHostId === LOCAL_EXECUTION_HOST_ID
        ? getLocalProjectWorktreeGitOptions(store, repo)
        : {}
    return { worktree, repo, executionHostId, localGitOptions }
  }

  // Why: same defect as `resolveRuntimeGitTarget` above, in ~30 filesystem dispatches. `getRepo(id)`
  // is host-blind and never read `worktree.hostId`, and the `connectionId` it returned spelled
  // "runtime host", "unresolved" and "genuinely local" all as `undefined` (#11163).
  protected async resolveRuntimeFileTarget(worktreeSelector: string): Promise<{
    worktree: ResolvedWorktree
    executionHostId: ExecutionHostId
  }> {
    // The floating workspace has no row to resolve. Answering here rather than at each caller
    // keeps one resolver authoritative for "where does this workspace live".
    if (isFloatingWorkspaceSelector(worktreeSelector)) {
      return {
        worktree: this.floatingWorkspaceToResolvedWorktree(
          await this.resolveFloatingWorkspacePath()
        ),
        executionHostId: LOCAL_EXECUTION_HOST_ID
      }
    }
    const folderScope = await this.resolveFolderWorkspaceLaunchScope(worktreeSelector)
    if (folderScope?.folderWorkspace) {
      // A folder workspace has no repo row to disagree with; its own inference already threw on an
      // ambiguous one, and it is never hosted by a runtime environment.
      return {
        worktree: this.folderWorkspaceToResolvedWorktree(folderScope.folderWorkspace),
        executionHostId: getConnectionExecutionHostId(folderScope.connectionId)
      }
    }

    const store = this.requireStore()
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const routing = resolveWorktreeHostRouting(store.getRepos(), worktree)
    if (routing.kind === 'ambiguous') {
      throw new Error('worktree_execution_host_unresolved')
    }
    return {
      worktree,
      executionHostId: routing.kind === 'resolved' ? routing.hostId : LOCAL_EXECUTION_HOST_ID
    }
  }
}
