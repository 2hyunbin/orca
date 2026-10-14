import { useEffect, useEffectEvent, useRef } from 'react'
import type { HostedReviewCreationEligibility } from '../../../../../../shared/hosted-review'
import {
  buildLocalBlockerHostedReviewCreationEligibility,
  resolveHostedReviewCreationProviderForTarget
} from './hosted-review-creation-eligibility-snapshot'
import type { SourceControlStoreActions } from '../listing/use-store-actions'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlHostedReviewState } from './use-hosted-review-state'
import type { SourceControlLinkedReviews } from './use-linked-reviews'
import type { SourceControlHostedReviewProviderHint } from './use-hosted-review-provider-hint'

/**
 * Probes whether a hosted review can be created for the visible branch and parks the answer in the
 * creation state, degrading to a local-only blocker when the remote probe fails.
 */
export function useSourceControlHostedReviewEligibility({
  activeGitStatusHead,
  activeRepoConnectionId,
  activeRepoExecutionHostId,
  activeRepoId,
  activeRepoPath,
  activeRepoRemoteUrl,
  activeWorktreeId,
  branchName,
  effectiveBaseRef,
  fallbackGitHubPRNumber,
  getHostedReviewCreationEligibility,
  hasUncommittedEntries,
  hostedReviewLookup,
  isBranchVisible,
  isCreatePrIntentInFlight,
  isCreatingPr,
  isFolder,
  linkedAzureDevOpsPR,
  linkedBitbucketPR,
  linkedGitHubPR,
  linkedGitLabMR,
  linkedGiteaPR,
  prGenerating,
  provisionalHostedReviewProvider,
  remoteStatus,
  hostedReviewCreationProviderHintRef,
  setHostedReviewCreationRequestState,
  setHostedReviewCreationState,
  worktreePath
}: {
  activeGitStatusHead: SourceControlWorktreeContext['activeGitStatusHead']
  activeRepoConnectionId: SourceControlWorktreeContext['activeRepoConnectionId']
  activeRepoExecutionHostId: SourceControlWorktreeContext['activeRepoExecutionHostId']
  activeRepoId: SourceControlWorktreeContext['activeRepoId']
  activeRepoPath: SourceControlWorktreeContext['activeRepoPath']
  activeRepoRemoteUrl: string | null
  activeWorktreeId: string | null
  branchName: string
  effectiveBaseRef: string | null
  fallbackGitHubPRNumber: SourceControlLinkedReviews['fallbackGitHubPRNumber']
  getHostedReviewCreationEligibility: SourceControlStoreActions['getHostedReviewCreationEligibility']
  hasUncommittedEntries: boolean
  hostedReviewLookup: SourceControlWorktreeContext['hostedReviewLookup']
  isBranchVisible: boolean
  isCreatePrIntentInFlight: boolean
  isCreatingPr: boolean
  isFolder: boolean
  linkedAzureDevOpsPR: SourceControlLinkedReviews['linkedAzureDevOpsPR']
  linkedBitbucketPR: SourceControlLinkedReviews['linkedBitbucketPR']
  linkedGitHubPR: SourceControlLinkedReviews['linkedGitHubPR']
  linkedGitLabMR: SourceControlLinkedReviews['linkedGitLabMR']
  linkedGiteaPR: SourceControlLinkedReviews['linkedGiteaPR']
  prGenerating: boolean
  provisionalHostedReviewProvider: SourceControlHostedReviewProviderHint['provisionalHostedReviewProvider']
  remoteStatus: SourceControlWorktreeContext['remoteStatus']
  hostedReviewCreationProviderHintRef: SourceControlHostedReviewState['hostedReviewCreationProviderHintRef']
  setHostedReviewCreationRequestState: SourceControlHostedReviewState['setHostedReviewCreationRequestState']
  setHostedReviewCreationState: SourceControlHostedReviewState['setHostedReviewCreationState']
  worktreePath: string | null
}): void {
  const reviewLookupChangedRef = useRef<
    ((lookup: SourceControlWorktreeContext['hostedReviewLookup']) => void) | null
  >(null)
  const readHostedReviewLookup = useEffectEvent(() => hostedReviewLookup)
  const resolveCurrentHostedReviewCreationProvider = useEffectEvent(() =>
    resolveHostedReviewCreationProviderForTarget(
      hostedReviewCreationProviderHintRef.current,
      { repoId: activeRepoId, worktreeId: activeWorktreeId ?? null, branch: branchName },
      // Why: provisional already infers the remote host and defaults to github; never fall back to unsupported mid-load.
      provisionalHostedReviewProvider
    )
  )

  useEffect(() => {
    if (
      !isBranchVisible ||
      !activeRepoId ||
      !activeRepoPath ||
      isFolder ||
      !branchName ||
      !activeWorktreeId
    ) {
      setHostedReviewCreationState(null)
      setHostedReviewCreationRequestState(null)
      return
    }
    // Why: skip refetches while a PR flow is mid-flight — recomputing eligibility then can tear down the composer before the final refresh restores truth.
    if (prGenerating || isCreatingPr || isCreatePrIntentInFlight) {
      setHostedReviewCreationRequestState(null)
      return
    }
    let stale = false
    let pending = false
    let latestLookup = readHostedReviewLookup()
    let observedLookup = latestLookup
    let settledEligibility: HostedReviewCreationEligibility | null = null
    const reviewLookupChanged = (
      lookup: SourceControlWorktreeContext['hostedReviewLookup']
    ): void => {
      if (stale || !lookup || (latestLookup && lookup.revision < latestLookup.revision)) {
        return
      }
      latestLookup = lookup
      if (pending || lookup === observedLookup) {
        return
      }
      const previousLookup = observedLookup
      if (previousLookup && lookup.revision <= previousLookup.revision) {
        return
      }
      observedLookup = lookup
      const needsRecovery =
        !settledEligibility ||
        settledEligibility.provider === 'unsupported' ||
        settledEligibility.reviewLookupOutcome === 'unavailable'
      const reviewChanged =
        lookup.number !== (settledEligibility?.review?.number ?? null) ||
        (lookup.number !== null
          ? lookup.provider !== settledEligibility?.provider
          : settledEligibility?.blockedReason === 'existing_review' ||
            settledEligibility?.reviewLookupOutcome === 'found')
      if (needsRecovery || reviewChanged) {
        probe(true)
      }
    }
    const probe = (revalidateReview: boolean): void => {
      pending = true
      observedLookup = latestLookup
      settledEligibility = null
      setHostedReviewCreationRequestState({
        repoId: activeRepoId,
        worktreeId: activeWorktreeId,
        branch: branchName,
        status: 'loading'
      })
      // Why: upstream/status changes can make the previous eligibility unsafe to click while the new preflight resolves.
      setHostedReviewCreationState(null)
      void getHostedReviewCreationEligibility({
        repoPath: activeRepoPath,
        repoId: activeRepoId,
        ...(worktreePath ? { worktreePath } : {}),
        branch: branchName,
        base: effectiveBaseRef ?? null,
        ...(revalidateReview ? { revalidateReview: true } : {}),
        hasUncommittedChanges: hasUncommittedEntries,
        hasUpstream: remoteStatus?.hasUpstream,
        ahead: remoteStatus?.ahead,
        behind: remoteStatus?.behind,
        linkedGitHubPR,
        fallbackGitHubPR: fallbackGitHubPRNumber,
        linkedGitLabMR,
        linkedBitbucketPR,
        linkedAzureDevOpsPR,
        linkedGiteaPR
      })
        .then((result) => {
          if (!stale) {
            settledEligibility = result
            setHostedReviewCreationState({
              repoId: activeRepoId,
              worktreeId: activeWorktreeId,
              branch: branchName,
              data: result
            })
            setHostedReviewCreationRequestState(null)
          }
        })
        .catch((error) => {
          console.warn('[SourceControl] hosted review creation eligibility failed', error)
          if (stale) {
            return
          }
          // Why: a failed remote probe can give branch guidance but cannot authorize hosted-review creation.
          const localBlocker = buildLocalBlockerHostedReviewCreationEligibility(
            resolveCurrentHostedReviewCreationProvider(),
            {
              branch: branchName,
              baseRef: effectiveBaseRef,
              hasUncommittedChanges: hasUncommittedEntries,
              hasUpstream: remoteStatus?.hasUpstream,
              ahead: remoteStatus?.ahead,
              behind: remoteStatus?.behind
            }
          )
          if (localBlocker) {
            settledEligibility = localBlocker
            setHostedReviewCreationState({
              repoId: activeRepoId,
              worktreeId: activeWorktreeId,
              branch: branchName,
              data: localBlocker
            })
            setHostedReviewCreationRequestState(null)
            return
          }
          setHostedReviewCreationState(null)
          setHostedReviewCreationRequestState({
            repoId: activeRepoId,
            worktreeId: activeWorktreeId,
            branch: branchName,
            status: 'failed'
          })
        })
        .finally(() => {
          pending = false
          // A lookup published during this probe must still get a chance to invalidate its answer.
          reviewLookupChanged(latestLookup)
        })
    }
    reviewLookupChangedRef.current = reviewLookupChanged
    probe(latestLookup !== null)
    return () => {
      stale = true
      reviewLookupChangedRef.current = null
    }
  }, [
    // Why: unrelated repo metadata replacement must not restart a hung probe's timeout.
    activeRepoConnectionId,
    activeRepoExecutionHostId,
    activeGitStatusHead,
    activeRepoId,
    activeRepoPath,
    activeRepoRemoteUrl,
    branchName,
    effectiveBaseRef,
    getHostedReviewCreationEligibility,
    hasUncommittedEntries,
    setHostedReviewCreationRequestState,
    setHostedReviewCreationState,
    isBranchVisible,
    isCreatingPr,
    isCreatePrIntentInFlight,
    isFolder,
    linkedGitHubPR,
    fallbackGitHubPRNumber,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR,
    prGenerating,
    remoteStatus?.ahead,
    remoteStatus?.behind,
    remoteStatus?.hasUpstream,
    remoteStatus?.upstreamName,
    activeWorktreeId,
    worktreePath
  ])
  useEffect(() => {
    reviewLookupChangedRef.current?.(hostedReviewLookup)
  }, [hostedReviewLookup])
}
