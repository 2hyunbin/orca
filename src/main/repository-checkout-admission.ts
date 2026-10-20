import type { Repo } from '../shared/repo-types'
import { normalizeRuntimePathForComparison as pathKey } from '../shared/cross-platform-path'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../shared/execution-host'
import { isFolderRepo } from '../shared/repo-kind'
import { awaitWindowsHostGitEnvironmentReady } from './git/runner'
import { getGitRepoRootAsync, inspectGitRepoForRegistrationAsync } from './git/repo'
import { findProjectAtSameRealPath } from './project-realpath-identity'
import { runtimeRepoMatchesExecutionHost } from './runtime/runtime-worktree-selection'

export type RepositoryCheckoutAdmission = {
  selectedPath: string
  registrationPath: string
  mainRepoPath: string | null
  findSaved: () => Repo | undefined
}

/** The files are inspected here; SSH paths cannot claim a checkout on this physical host. */
export async function admitRepositoryCheckout(
  store: { getRepos(): Repo[] },
  selectedPath: string,
  kind: 'git' | 'folder',
  executionHostId?: ExecutionHostId | null
): Promise<RepositoryCheckoutAdmission> {
  if (kind === 'git') await awaitWindowsHostGitEnvironmentReady({ cwd: selectedPath })
  const info = kind === 'git' ? await inspectGitRepoForRegistrationAsync(selectedPath) : null
  if (info && !info.isRepo) throw new Error(`Not a valid git repository: ${selectedPath}`)
  const registrationPath = info?.rootPath ?? selectedPath
  const mainRepoPath = info?.mainRepoPath ? await getGitRepoRootAsync(info.mainRepoPath) : null
  const sameHostRepos = () => store.getRepos().filter((repo) =>
    parseExecutionHostId(getRepoExecutionHostId(repo))?.kind !== 'ssh' &&
    (executionHostId === LOCAL_EXECUTION_HOST_ID
      ? getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
      : runtimeRepoMatchesExecutionHost(repo, executionHostId)))
  const matches = (repo: Repo) => pathKey(repo.path) === pathKey(selectedPath) ||
    pathKey(repo.path) === pathKey(registrationPath) ||
    (mainRepoPath !== null && !isFolderRepo(repo) && pathKey(repo.path) === pathKey(mainRepoPath))
  const realPathMatch = sameHostRepos().find(matches) ??
    await findProjectAtSameRealPath(sameHostRepos(), registrationPath)
  return {
    selectedPath,
    registrationPath,
    mainRepoPath,
    // Re-read after asynchronous discovery; never retain a deleted or transferred claim.
    findSaved: () => sameHostRepos().find(matches) ?? sameHostRepos().find((repo) =>
      realPathMatch !== null && repo.id === realPathMatch.id &&
      pathKey(repo.path) === pathKey(realPathMatch.path))
  }
}
