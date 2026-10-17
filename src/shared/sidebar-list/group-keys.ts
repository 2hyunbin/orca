import type { Repo } from '../repo-types'
import type { Worktree } from '../worktree/types'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import { UNGROUPED_PROJECT_GROUP_KEY } from '../project-groups'
import type { SidebarListSettings } from './row-types'
import { getGitHubPRCacheKey, getLegacyGitHubPRCacheKey } from '../github/github-cache-key'
import { isGitHubPRSuppressed } from '../worktree/github-pr-suppression'
import { getPRGroupKeyForState, type PRGroupKey } from '../workspace-view/workspace-pr-groups'

export {
  PR_GROUP_ORDER,
  getPRLaneKey,
  type PRGroupKey
} from '../workspace-view/workspace-pr-groups'

export function getProjectGroupHeaderKey(groupId: string | null): string {
  return groupId ? `project-group:${groupId}` : UNGROUPED_PROJECT_GROUP_KEY
}

export const PINNED_GROUP_KEY = 'pinned'

export const ALL_GROUP_KEY = 'all'

export const LINEAGE_GROUP_PREFIX = 'lineage:'

export function getLineageGroupKey(worktreeId: string): string {
  return `${LINEAGE_GROUP_PREFIX}${worktreeId}`
}

export function getWorktreeLineageGroupKey(worktree: Pick<Worktree, 'id' | 'hostId'>): string {
  return getLineageGroupKey(worktree.hostId ? getWorktreeHostIdentity(worktree) : worktree.id)
}

export function getPRGroupKey(
  worktree: Worktree,
  repoMap: Map<string, Repo>,
  prCache: Record<string, unknown> | null,
  settings?: SidebarListSettings
): PRGroupKey {
  const repo = repoMap.get(worktree.repoId)
  const branch = worktree.branch.replace(/^refs\/heads\//, '')
  const repoScopedCacheKey =
    repo && branch
      ? getGitHubPRCacheKey(
          repo.path,
          repo.id,
          branch,
          settings,
          repo.connectionId,
          repo.executionHostId,
          true
        )
      : ''
  const canUseLegacyPRCache = repo !== undefined && !repo.connectionId && !repo.executionHostId
  const legacyRepoScopedCacheKey =
    canUseLegacyPRCache && branch ? getLegacyGitHubPRCacheKey(repo.path, repo.id, branch) : ''
  const legacyPathScopedCacheKey =
    canUseLegacyPRCache && branch ? getLegacyGitHubPRCacheKey(repo.path, undefined, branch) : ''
  // Why: PR refreshes now write repo-id scoped entries; legacy path entries may
  // still exist from persisted cache, but must not override fresher repo data.
  const prEntry = prCache
    ? ((repoScopedCacheKey
        ? (prCache[repoScopedCacheKey] as
            | { data?: { number?: number; state?: string } }
            | undefined)
        : undefined) ??
      (legacyRepoScopedCacheKey
        ? (prCache[legacyRepoScopedCacheKey] as
            | { data?: { number?: number; state?: string } }
            | undefined)
        : undefined) ??
      (legacyPathScopedCacheKey
        ? (prCache[legacyPathScopedCacheKey] as
            | { data?: { number?: number; state?: string } }
            | undefined)
        : undefined))
    : undefined
  const pr = prEntry?.data

  if (!pr || (typeof pr.number === 'number' && isGitHubPRSuppressed(worktree, pr.number))) {
    return 'in-progress'
  }
  return getPRGroupKeyForState(pr.state ?? '')
}
