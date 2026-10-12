import type { ExecutionHostScope } from '../../../shared/execution-host'
import {
  getNewWorkspaceDialogEligibleRepos,
  resolveNewWorkspaceDialogActiveRepoId,
  resolveNewWorkspaceDialogGitRepoId,
  resolveNewWorkspaceDialogRepoId
} from '../../../shared/new-workspace-dialog-repo'
import type { Repo } from '../../../shared/repo-types'

export function getComposerEligibleRepos(repos: readonly Repo[]): Repo[] {
  return getNewWorkspaceDialogEligibleRepos(repos)
}

export function resolveComposerActiveRepoId(
  repos: readonly Repo[],
  eligibleRepos: readonly Repo[],
  activeRepoId: string | null | undefined
): string | null {
  return resolveNewWorkspaceDialogActiveRepoId(repos, eligibleRepos, activeRepoId)
}

export function resolveComposerRepoId({
  eligibleRepos,
  draftRepoId,
  initialRepoId,
  activeRepoId,
  focusedHostScope
}: {
  eligibleRepos: readonly Repo[]
  draftRepoId?: string | null
  initialRepoId?: string | null
  activeRepoId?: string | null
  focusedHostScope?: ExecutionHostScope | null
}): string {
  return resolveNewWorkspaceDialogRepoId({
    eligibleRepos,
    draftRepoId,
    initialRepoId,
    activeRepoId,
    focusedHostScope
  })
}

export function resolveComposerGitRepoId(args: {
  eligibleRepos: readonly Repo[]
  draftRepoId?: string | null
  initialRepoId?: string | null
  activeRepoId?: string | null
  focusedHostScope?: ExecutionHostScope | null
}): string | null {
  return resolveNewWorkspaceDialogGitRepoId(args)
}
