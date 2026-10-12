import {
  ALL_EXECUTION_HOSTS_SCOPE,
  getRepoExecutionHostId,
  isRuntimeOwnedSshTargetId,
  type ExecutionHostScope
} from './execution-host'
import { getProjectIdentityKey } from './project-host-setup-projection'
import { isGitRepoKind } from './repo-kind'
import type { Repo } from './repo-types'

type NewWorkspaceDialogRepo = Pick<
  Repo,
  'id' | 'path' | 'kind' | 'connectionId' | 'executionHostId'
>

export function getNewWorkspaceDialogEligibleRepos<T extends Pick<Repo, 'path' | 'connectionId'>>(
  repos: readonly T[]
): T[] {
  // Why: a runtime-owned (per-workspace-env) SSH repo is hidden plumbing, not a real project. If it
  // were selectable here, creating an ephemeral VM would seed the composer to that repo — which has
  // no recipes — hiding the "Run on" picker entirely on the next create. Exclude it like every other
  // user-facing surface does.
  return repos.filter((repo) => Boolean(repo.path) && !isRuntimeOwnedSshTargetId(repo.connectionId))
}

type ActiveRepoCandidate = Pick<
  Repo,
  'id' | 'connectionId' | 'upstream' | 'repoIcon' | 'gitRemoteIdentity'
>

/**
 * After creating a per-workspace-env, its runtime-owned SSH repo becomes the active repo — but it's
 * excluded from the eligible repos (hidden plumbing). Without this, the dialog can't match
 * `activeRepoId`, so it falls back to the first eligible repo (a different project). Map the active
 * runtime repo to its sibling in the same project so the dialog stays on that project.
 */
export function resolveNewWorkspaceDialogActiveRepoId(
  repos: readonly ActiveRepoCandidate[],
  eligibleRepos: readonly ActiveRepoCandidate[],
  activeRepoId: string | null | undefined
): string | null {
  if (!activeRepoId) {
    return activeRepoId ?? null
  }
  const activeRepo = repos.find((repo) => repo.id === activeRepoId)
  if (!activeRepo || !isRuntimeOwnedSshTargetId(activeRepo.connectionId)) {
    return activeRepoId
  }
  const projectKey = getProjectIdentityKey(activeRepo)
  const sibling = eligibleRepos.find((repo) => getProjectIdentityKey(repo) === projectKey)
  return sibling?.id ?? activeRepoId
}

export function resolveNewWorkspaceDialogRepoId({
  eligibleRepos,
  draftRepoId,
  initialRepoId,
  activeRepoId,
  focusedHostScope
}: {
  eligibleRepos: readonly NewWorkspaceDialogRepo[]
  draftRepoId?: string | null
  initialRepoId?: string | null
  activeRepoId?: string | null
  focusedHostScope?: ExecutionHostScope | null
}): string {
  // Why: every new-workspace dialog, desktop and mobile, seeds the repo the same way.
  const focusedHostRepo =
    focusedHostScope && focusedHostScope !== ALL_EXECUTION_HOSTS_SCOPE
      ? eligibleRepos.find((repo) => getRepoExecutionHostId(repo) === focusedHostScope)
      : undefined

  const resolvedRepo =
    (draftRepoId && eligibleRepos.find((repo) => repo.id === draftRepoId)) ||
    (initialRepoId && eligibleRepos.find((repo) => repo.id === initialRepoId)) ||
    (activeRepoId && eligibleRepos.find((repo) => repo.id === activeRepoId)) ||
    focusedHostRepo ||
    eligibleRepos[0]

  return resolvedRepo?.id ?? ''
}

export function resolveNewWorkspaceDialogGitRepoId(args: {
  eligibleRepos: readonly NewWorkspaceDialogRepo[]
  draftRepoId?: string | null
  initialRepoId?: string | null
  activeRepoId?: string | null
  focusedHostScope?: ExecutionHostScope | null
}): string | null {
  const repoId = resolveNewWorkspaceDialogRepoId(args)
  const repo = repoId ? args.eligibleRepos.find((entry) => entry.id === repoId) : null
  return repo && isGitRepoKind(repo) ? repo.id : null
}
