import { renderHook } from '@testing-library/react'
import { vi } from 'vitest'
import type { HostedReviewCreationEligibility } from '../../../../../../shared/hosted-review'
import { useSourceControlHostedReviewEligibility } from './use-hosted-review-eligibility'
import { useSourceControlHostedReviewState } from './use-hosted-review-state'
import { resolveCreatePrHeaderAction } from './primary-create-pr-intent-action'

export type Input = Omit<
  Parameters<typeof useSourceControlHostedReviewEligibility>[0],
  | 'hostedReviewCreationProviderHintRef'
  | 'setHostedReviewCreationRequestState'
  | 'setHostedReviewCreationState'
>

export const dirty: HostedReviewCreationEligibility = {
  provider: 'github',
  review: null,
  canCreate: false,
  blockedReason: 'dirty',
  nextAction: 'commit',
  defaultBaseRef: 'origin/main',
  reviewLookupOutcome: 'not_found'
}
export const unsupported: HostedReviewCreationEligibility = {
  ...dirty,
  provider: 'unsupported',
  blockedReason: 'unsupported_provider',
  nextAction: null
}
export const existing: HostedReviewCreationEligibility = {
  ...dirty,
  provider: 'gitlab',
  review: { number: 42, url: 'https://gitlab.com/acme/orca/-/merge_requests/42' },
  blockedReason: 'existing_review',
  nextAction: 'open_existing_review',
  reviewLookupOutcome: 'found'
}

export function makeInput(overrides: Partial<Input> = {}): Input {
  return {
    activeGitStatusHead: 'head-1',
    activeRepoConnectionId: null,
    activeRepoExecutionHostId: null,
    activeRepoId: 'repo-1',
    activeRepoPath: '/repo',
    activeRepoRemoteUrl: null,
    activeWorktreeId: 'wt-1',
    branchName: 'improve-test-detection',
    effectiveBaseRef: 'origin/main',
    fallbackGitHubPRNumber: null,
    getHostedReviewCreationEligibility: vi.fn().mockResolvedValue(dirty),
    hasUncommittedEntries: true,
    hostedReviewLookup: null,
    isBranchVisible: true,
    isCreatePrIntentInFlight: false,
    isCreatingPr: false,
    isFolder: false,
    linkedAzureDevOpsPR: null,
    linkedBitbucketPR: null,
    linkedGitHubPR: null,
    linkedGitLabMR: null,
    linkedGiteaPR: null,
    prGenerating: false,
    provisionalHostedReviewProvider: 'github',
    remoteStatus: { hasUpstream: true, ahead: 0, behind: 74 },
    worktreePath: '/repo',
    ...overrides
  }
}

export function renderEligibility(input: Input) {
  return renderHook(
    (current: Input) => {
      const state = useSourceControlHostedReviewState({
        activePrFromQueue: null,
        activeRepoId: current.activeRepoId,
        activeWorktreeId: current.activeWorktreeId,
        branchName: current.branchName,
        hostedReviewCacheKey: null,
        hostedReviewEntryData: null,
        linkedPR: null,
        suppressedGitHubPR: null
      })
      useSourceControlHostedReviewEligibility({ ...current, ...state })
      return {
        ...state,
        action: resolveCreatePrHeaderAction({
          stagedCount: 7,
          hasUnstagedChanges: false,
          hasStageableChanges: false,
          hasPartiallyStagedChanges: false,
          hasMessage: false,
          hasUnresolvedConflicts: false,
          isCommitting: false,
          isRemoteOperationActive: false,
          upstreamStatus: current.remoteStatus,
          hostedReviewCreation: state.hostedReviewCreation,
          branchCommitsAhead: 0,
          hasCurrentBranch: true
        })
      }
    },
    { initialProps: input }
  )
}
