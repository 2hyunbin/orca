import { randomUUID } from 'node:crypto'
import type { Store } from '../../persistence'
import type { Repo } from '../../../shared/repo-types'
import { DEFAULT_REPO_BADGE_COLOR } from '../../../shared/constants'
import { getRepoName } from '../../git/repo'
import { admitRepositoryCheckout } from '../../repository-checkout-admission'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { detectRepoIconAndUpstream } from '../../repo-icon-autodetect'
import { prepareLocalWorktreeRootForRepo } from '../../worktree-root-preparation'
import { registerProjectOnWslHost } from '../../wsl/wsl-project-registration'

export async function addLocalRepoFromPath(
  store: Store,
  path: string,
  kind: 'git' | 'folder' = 'git',
  displayName?: string
): Promise<{ repo: Repo; alreadyExisted: boolean } | { error: string }> {
  const repoKind = kind === 'folder' ? 'folder' : 'git'
  let admission
  try {
    admission = await admitRepositoryCheckout(store, path, repoKind, LOCAL_EXECUTION_HOST_ID)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  const existing = admission.findSaved()
  if (existing) return { repo: existing, alreadyExisted: true }
  const resolvedPath = admission.registrationPath
  const hosted = await registerProjectOnWslHost(
    store, { kind: 'add', path: resolvedPath, repoKind, displayName }, { admission }
  )
  if (hosted) return { repo: hosted, alreadyExisted: false }

  const detected = await detectRepoIconAndUpstream({
    repoPath: resolvedPath,
    kind: repoKind,
    executionHostId: LOCAL_EXECUTION_HOST_ID
  })
  // Another registration can finish while icon discovery is pending.
  const raceWinner = admission.findSaved()
  if (raceWinner) {
    return { repo: raceWinner, alreadyExisted: true }
  }
  const repo: Repo = {
    id: randomUUID(),
    path: resolvedPath,
    displayName: displayName?.trim() || getRepoName(resolvedPath),
    badgeColor: DEFAULT_REPO_BADGE_COLOR,
    ...detected,
    addedAt: Date.now(),
    kind: repoKind,
    ...(repoKind === 'git'
      ? {
          externalWorktreeVisibilityLegacy: false,
          // Why: new Add Project imports are explicit ready host setups; 'legacy-repo' is reserved for older records/projection.
          projectHostSetupMethod: 'imported-existing-folder' as const
        }
      : {})
  }

  store.addRepo(repo)
  await prepareLocalWorktreeRootForRepo(store, repo)
  return { repo, alreadyExisted: false }
}
