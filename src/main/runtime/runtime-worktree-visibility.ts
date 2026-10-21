import type { Repo } from '../../shared/repo-types'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { getRepoHostIdentityForParts } from '../../shared/repo-host-identity'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import {
  createWorktreeVisibilitySourceMatcher,
  resolveCustomWorktreeVisibilitySources
} from '../../shared/worktree/visibility-sources'
import { resolveConfiguredWorktreeBasePaths } from '../../shared/worktree/configured-worktree-base-path'

export function buildRuntimeWorktreeVisibilityMatchers(
  repos: readonly Repo[],
  resolved: readonly ResolvedWorktree[],
  visibilityDefaults: Parameters<typeof resolveCustomWorktreeVisibilitySources>[1]
) {
  const pathsByRepo = new Map<string, string[]>()
  for (const worktree of resolved) {
    const paths =
      pathsByRepo.get(getRepoHostIdentityForParts(worktree.repoId, worktree.hostId ?? 'local')) ??
      []
    paths.push(worktree.path)
    pathsByRepo.set(getRepoHostIdentityForParts(worktree.repoId, worktree.hostId ?? 'local'), paths)
  }
  return new Map(
    repos.map((repo) => [
      getRepoHostIdentityForParts(repo.id, getRepoExecutionHostId(repo)),
      createWorktreeVisibilitySourceMatcher(
        [
          repo.path,
          ...(pathsByRepo.get(getRepoHostIdentityForParts(repo.id, getRepoExecutionHostId(repo))) ??
            [])
        ],
        resolveCustomWorktreeVisibilitySources(repo, visibilityDefaults),
        resolveConfiguredWorktreeBasePaths(repo)
      )
    ])
  )
}
