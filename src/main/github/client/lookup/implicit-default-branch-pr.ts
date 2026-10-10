import type { OwnerRepo } from '../../gh-utils'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import {
  getRemoteHeadBranchName,
  getRepoDefaultBranchName
} from '../../../source-control/repo-default-branch'
import type { HostedReviewLocalGitOptions } from './../github-exec-scope'
import type { TrackedUpstreamBranch } from './tracked-upstream-cache'
import { pullRequestHeadRepository, type PullRequestLookupData } from './pull-request-lookup-data'

export async function shouldHideImplicitDefaultBranchPR(input: {
  data: PullRequestLookupData
  prRepo: OwnerRepo | null
  originHeadRepo: OwnerRepo | null
  trackedUpstream: { branch: TrackedUpstreamBranch; headRepo: OwnerRepo } | null
  branchName: string
  linkedPRNumber?: number | null
  repoPath: string
  connectionId?: string | null
  localGitOptions: HostedReviewLocalGitOptions
}): Promise<boolean> {
  const { data, branchName, prRepo } = input
  if (
    !branchName ||
    !data.headRefName ||
    data.headRefName === branchName ||
    typeof input.linkedPRNumber === 'number'
  ) {
    return false
  }
  const headRepo = pullRequestHeadRepository(data, prRepo)
  // Fork heads are real review branches even when their name is a default branch elsewhere.
  if (!headRepo || !prRepo || githubRepoIdentityKey(headRepo) !== githubRepoIdentityKey(prRepo)) {
    return false
  }
  if (data.headDefaultBranchName) {
    return data.headRefName === data.headDefaultBranchName
  }
  const headRepoKey = githubRepoIdentityKey(headRepo)
  const remoteName =
    input.trackedUpstream && githubRepoIdentityKey(input.trackedUpstream.headRepo) === headRepoKey
      ? input.trackedUpstream.branch.remoteName
      : input.originHeadRepo && githubRepoIdentityKey(input.originHeadRepo) === headRepoKey
        ? 'origin'
        : null
  if (!remoteName) {
    return false
  }
  // An unknown upstream HEAD cannot borrow a different repository's origin default.
  const defaultBranchName =
    remoteName === 'origin'
      ? await getRepoDefaultBranchName(input.repoPath, input.connectionId, input.localGitOptions)
      : await getRemoteHeadBranchName(
          input.repoPath,
          remoteName,
          input.connectionId,
          input.localGitOptions
        )
  return defaultBranchName !== null && data.headRefName === defaultBranchName
}
