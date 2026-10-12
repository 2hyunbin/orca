// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import type { RuntimeStructuredSessionTabs } from './session-tabs/structured-session-tabs'

import { OrcaRuntimeWithGetStructuredAgentSessionCreateSupport } from './orca-runtime-get-structured-agent-session-create-support'

import type { RuntimeRepoSearchRefs } from '../../shared/runtime-types'

import { DEFAULT_REPO_SEARCH_REFS_LIMIT } from './orca-runtime-postlude'
import type { Repo } from '../../shared/repo-types'
import type { GitAdmissionTier } from '../git/command-runner/git-exec-options'
import {
  getLocalProjectGhExecOptions,
  resolveLocalProjectRuntimeForRepo,
  type LocalProjectGhExecOptions
} from '../project-runtime-git-options'
import { getAgentLaunchPlatformForRepo } from './runtime-agent-launch-resolution'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { isWslUncPath } from '../../shared/wsl-paths'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import type { PtyProcessInspection } from '../providers/pty-process-inspection'

export class OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce extends OrcaRuntimeWithGetStructuredAgentSessionCreateSupport {
  publishStructuredAgentSessionTab(
    ...args: Parameters<RuntimeStructuredSessionTabs['publishStructuredAgentSessionTab']>
  ): ReturnType<RuntimeStructuredSessionTabs['publishStructuredAgentSessionTab']> {
    return this.runtimeStructuredSessionTabs.publishStructuredAgentSessionTab(...args)
  }

  /** The runtime's own snapshot of a chat tab. Records nothing: the caller owns the store write. */
  projectStructuredAgentSessionTab(
    ...args: Parameters<RuntimeStructuredSessionTabs['projectStructuredAgentSessionTab']>
  ): ReturnType<RuntimeStructuredSessionTabs['projectStructuredAgentSessionTab']> {
    return this.runtimeStructuredSessionTabs.projectStructuredAgentSessionTab(...args)
  }

  async inspectTerminalProcess(
    terminalSelector: string,
    options?: { expectedIncarnationId?: string; scanChildProcesses?: boolean }
  ): Promise<PtyProcessInspection> {
    const leaf = this.resolveLiveLeafForHandle(terminalSelector)
    if (!leaf?.ptyId || !this.ptyController) {
      throw new Error('terminal_gone')
    }
    if (this.ptyController.inspectProcess) {
      // Preserve the legacy one-argument call shape when no incarnation
      // fence was requested; some providers use arity to distinguish the
      // compatibility path from the fenced remote inspection.
      const inspection =
        options === undefined
          ? await this.ptyController.inspectProcess(leaf.ptyId)
          : await this.ptyController.inspectProcess(leaf.ptyId, options)
      const evidence = inspection.foregroundProcessEvidence
      // The runtime handle is the request identity on this wire; keep the
      // host-owned leaf PTY id out of the client-facing comparison.
      const relayPtyId = parseAppSshPtyId(leaf.ptyId)?.relayPtyId
      const evidenceBelongsToLeaf =
        evidence !== undefined && (evidence.ptyId === leaf.ptyId || evidence.ptyId === relayPtyId)
      return evidenceBelongsToLeaf
        ? { ...inspection, foregroundProcessEvidence: { ...evidence, ptyId: terminalSelector } }
        : inspection
    }
    const foregroundProcess = await this.ptyController.getForegroundProcess(leaf.ptyId)
    const hasChildProcesses = (await this.ptyController.hasChildProcesses?.(leaf.ptyId)) ?? false
    return { foregroundProcess, hasChildProcesses }
  }

  async searchRepoRefs(
    repoSelector: string,
    query: string,
    limit = DEFAULT_REPO_SEARCH_REFS_LIMIT,
    includeQualifiedRefs = true
  ): Promise<RuntimeRepoSearchRefs> {
    return this.repositoryRefQueries.search(repoSelector, query, limit, includeQualifiedRefs)
  }

  protected async resolveHostedReviewTarget(args: {
    repoSelector: string
    worktreeSelector?: string
  }): Promise<{ repo: Repo; repoPath: string }> {
    const repo = await this.resolveRepoSelector(args.repoSelector)
    if (!args.worktreeSelector) {
      return { repo, repoPath: repo.path }
    }

    const worktree = await this.resolveWorktreeSelector(args.worktreeSelector)
    if (worktree.repoId !== repo.id) {
      throw new Error('Access denied: worktree does not belong to repository')
    }
    return { repo, repoPath: worktree.path }
  }

  protected getHostedReviewExecutionOptions(
    repo: Repo,
    admissionTier?: GitAdmissionTier
  ):
    | { localGitExecOptions: LocalProjectGhExecOptions & { admissionTier?: GitAdmissionTier } }
    | undefined {
    const localGitOptions = {
      ...this.getLocalGitExecutionOptionArgs(repo)[0],
      ...(admissionTier && { admissionTier })
    }
    return Object.keys(localGitOptions).length > 0
      ? { localGitExecOptions: localGitOptions }
      : undefined
  }

  protected getLocalGitExecutionOptionArgs(repo: Repo): [] | [LocalProjectGhExecOptions] {
    const localGitOptions = getLocalProjectGhExecOptions(this.requireStore(), repo)
    return Object.keys(localGitOptions).length > 0 ? [localGitOptions] : []
  }

  protected getAgentLaunchPlatformForRepo(repo: Repo): NodeJS.Platform {
    const projectRuntime = repo.connectionId
      ? undefined
      : resolveLocalProjectRuntimeForRepo(this.requireStore(), repo)
    return getAgentLaunchPlatformForRepo(repo, projectRuntime)
  }

  protected getAgentLaunchPlatformForWorkspace(
    scope: Pick<TerminalWorkspaceLaunchScope, 'repo' | 'path'> &
      Partial<Pick<TerminalWorkspaceLaunchScope, 'connectionId'>>
  ): NodeJS.Platform {
    if (scope.repo) {
      return this.getAgentLaunchPlatformForRepo(scope.repo)
    }
    if (scope.connectionId) {
      return isWindowsAbsolutePathLike(scope.path) ? 'win32' : 'linux'
    }
    return isWslUncPath(scope.path) ? 'linux' : process.platform
  }

  protected restoreStructuredAgentSessionTabsOnce(
    ...args: Parameters<RuntimeStructuredSessionTabs['restoreStructuredAgentSessionTabsOnce']>
  ): ReturnType<RuntimeStructuredSessionTabs['restoreStructuredAgentSessionTabsOnce']> {
    return this.runtimeStructuredSessionTabs.restoreStructuredAgentSessionTabsOnce(...args)
  }
}
