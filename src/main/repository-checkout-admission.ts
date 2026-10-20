import type { Repo } from '../shared/repo-types'
import { normalizeWindowsWslPath } from '../shared/windows-path-access'
import { wslProjectRoutingEnabled } from './wsl/wsl-host-gate'
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
  executionHostId: ExecutionHostId | null
  wslRouting: boolean
  registrationPath: string
  mainRepoPath: string | null
  findSaved: () => Repo | undefined
}

/** The files are inspected here; SSH paths cannot claim a checkout on this physical host. */
export async function admitRepositoryCheckout(
  store: { getRepos(): Repo[]; getSettings?(): { experimentalWslHosts?: boolean } },
  selectedPath: string,
  kind: 'git' | 'folder',
  executionHostId?: ExecutionHostId | null,
  wslRouting = false
): Promise<RepositoryCheckoutAdmission> {
  if (kind === 'git') {
    await awaitWindowsHostGitEnvironmentReady({ cwd: selectedPath })
  }
  const info = kind === 'git' ? await inspectGitRepoForRegistrationAsync(selectedPath) : null
  if (info && !info.isRepo) {
    throw new Error(`Not a valid git repository: ${selectedPath}`)
  }
  const registrationPath = info?.rootPath ?? selectedPath
  const mainRepoPath = info?.mainRepoPath ? await getGitRepoRootAsync(info.mainRepoPath) : null
  const sameHostRepos = () =>
    store
      .getRepos()
      .filter(
        (repo) =>
          parseExecutionHostId(getRepoExecutionHostId(repo))?.kind !== 'ssh' &&
          (executionHostId === LOCAL_EXECUTION_HOST_ID
            ? getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
            : runtimeRepoMatchesExecutionHost(repo, executionHostId))
      )
  const matches = (repo: Repo) =>
    pathKey(repo.path) === pathKey(selectedPath) ||
    pathKey(repo.path) === pathKey(registrationPath) ||
    (mainRepoPath !== null && !isFolderRepo(repo) && pathKey(repo.path) === pathKey(mainRepoPath))
  const ordinaryMatch =
    sameHostRepos().find(matches) ??
    (await findProjectAtSameRealPath(sameHostRepos(), registrationPath))
  const scopedKey = (path: string) => pathKey(normalizeWindowsWslPath(path))
  const selectedMatches = (repo: Repo) =>
    scopedKey(repo.path) === scopedKey(selectedPath) ||
    scopedKey(repo.path) === scopedKey(registrationPath)
  const scopedMatch = wslRouting
    ? sameHostRepos().find(selectedMatches) ??
      (await findProjectAtSameRealPath(sameHostRepos(), registrationPath, scopedKey)) ??
      (mainRepoPath === null
        ? null
        : sameHostRepos().find(
            (repo) => !isFolderRepo(repo) && scopedKey(repo.path) === scopedKey(mainRepoPath)
          ) ??
          (await findProjectAtSameRealPath(
            sameHostRepos().filter((repo) => !isFolderRepo(repo)),
            mainRepoPath,
            scopedKey
          )))
    : null
  const ordinaryClaim = ordinaryMatch
    ? { id: ordinaryMatch.id, path: pathKey(ordinaryMatch.path) }
    : null
  const scopedClaim = scopedMatch
    ? { id: scopedMatch.id, path: scopedKey(scopedMatch.path), kind: scopedMatch.kind }
    : null
  return {
    selectedPath,
    executionHostId: executionHostId ?? null,
    wslRouting,
    registrationPath: wslRouting ? normalizeWindowsWslPath(registrationPath) : registrationPath,
    mainRepoPath,
    // Re-read live claims and policy; a deleted, transferred or disabled claim cannot win.
    findSaved: () => {
      const scoped = wslRouting && wslProjectRoutingEnabled(store, executionHostId)
      const key = scoped ? scopedKey : pathKey
      const claim = scoped ? scopedClaim : ordinaryClaim
      return (
        sameHostRepos().find(scoped ? selectedMatches : matches) ??
        sameHostRepos().find(
          (repo) =>
            claim !== null &&
            repo.id === claim.id &&
            key(repo.path) === claim.path &&
            (!scoped || repo.kind === scopedClaim?.kind)
        ) ??
        (scoped && mainRepoPath !== null
          ? sameHostRepos().find(
              (repo) => !isFolderRepo(repo) && scopedKey(repo.path) === scopedKey(mainRepoPath)
            )
          : undefined)
      )
    }
  }
}
