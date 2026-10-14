// @vitest-environment happy-dom

import { act, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewCreationEligibility } from '../../../../../../shared/hosted-review'
import {
  dirty,
  existing,
  makeInput,
  renderEligibility,
  unsupported
} from './hosted-review-eligibility-test-harness'

afterEach(cleanup)

describe('hosted review eligibility invalidation', () => {
  it('restores Create PR when remote metadata hydrates without leaving the workspace', async () => {
    const getEligibility = vi.fn().mockResolvedValueOnce(unsupported).mockResolvedValue(dirty)
    const input = makeInput({ getHostedReviewCreationEligibility: getEligibility })
    const { result, rerender } = renderEligibility(input)
    await act(async () => {})
    expect(result.current.action).toBeNull()

    rerender({ ...input, activeRepoRemoteUrl: 'git@github.com:acme/orca.git' })
    await act(async () => {})

    expect(getEligibility).toHaveBeenCalledTimes(2)
    expect(result.current.action).toMatchObject({ label: 'Create PR', kind: 'create_pr_intent' })
  })

  it('retires an existing-review snapshot after an accepted GitLab miss', async () => {
    const getEligibility = vi
      .fn()
      .mockResolvedValueOnce(existing)
      .mockResolvedValue({
        ...dirty,
        provider: 'gitlab'
      })
    const input = makeInput({
      getHostedReviewCreationEligibility: getEligibility,
      hostedReviewLookup: { revision: 1, provider: 'gitlab', number: 42 }
    })
    const { result, rerender } = renderEligibility(input)
    await act(async () => {})
    expect(result.current.action).toBeNull()

    rerender({ ...input, hostedReviewLookup: { revision: 2, provider: null, number: null } })
    await act(async () => {})

    expect(getEligibility).toHaveBeenCalledTimes(2)
    expect(result.current.action).toMatchObject({ label: 'Create MR', kind: 'create_pr_intent' })
    expect(getEligibility).toHaveBeenLastCalledWith(
      expect.objectContaining({ revalidateReview: true })
    )
  })

  it('reconciles an existing review whose older host response only included its URL', async () => {
    const getEligibility = vi
      .fn()
      .mockResolvedValueOnce({ ...existing, review: { url: existing.review?.url } })
      .mockResolvedValue(dirty)
    const input = makeInput({ getHostedReviewCreationEligibility: getEligibility })
    const { result, rerender } = renderEligibility(input)
    await act(async () => {})
    expect(result.current.action).toBeNull()
    rerender({ ...input, hostedReviewLookup: { revision: 2, provider: null, number: null } })
    await act(async () => {})
    expect(getEligibility).toHaveBeenCalledTimes(2)
    expect(result.current.action?.label).toBe('Create PR')
  })

  it('ignores older evidence and replacements of the same publication', async () => {
    const input = makeInput({ hostedReviewLookup: { revision: 2, provider: null, number: null } })
    const { rerender } = renderEligibility(input)
    await act(async () => {})
    rerender({ ...input, hostedReviewLookup: { revision: 1, provider: 'gitlab', number: 42 } })
    rerender({ ...input, hostedReviewLookup: { revision: 2, provider: null, number: null } })
    await act(async () => {})
    expect(input.getHostedReviewCreationEligibility).toHaveBeenCalledTimes(1)
  })

  it('rechecks a new HEAD on the same branch even when status counts are unchanged', async () => {
    const input = makeInput()
    const { rerender } = renderEligibility(input)
    await act(async () => {})
    rerender({ ...input, activeGitStatusHead: 'head-2' })
    await act(async () => {})
    expect(input.getHostedReviewCreationEligibility).toHaveBeenCalledTimes(2)
  })

  it('rechecks a changed upstream name even when status counts are unchanged', async () => {
    const input = makeInput()
    const { rerender } = renderEligibility(input)
    await act(async () => {})
    rerender({
      ...input,
      remoteStatus: { ahead: 0, behind: 74, hasUpstream: true, upstreamName: 'fork/feature' }
    })
    await act(async () => {})
    expect(input.getHostedReviewCreationEligibility).toHaveBeenCalledTimes(2)
  })

  it('recovers an incomplete probe on a newer lookup without rechecking healthy no-review refreshes', async () => {
    const getEligibility = vi.fn().mockResolvedValueOnce(unsupported).mockResolvedValue(dirty)
    const input = makeInput({
      getHostedReviewCreationEligibility: getEligibility,
      hostedReviewLookup: { revision: 1, provider: null, number: null }
    })
    const { result, rerender } = renderEligibility(input)
    await act(async () => {})

    rerender({ ...input, hostedReviewLookup: { revision: 2, provider: null, number: null } })
    await act(async () => {})
    expect(result.current.action?.label).toBe('Create PR')
    expect(getEligibility).toHaveBeenCalledTimes(2)

    rerender({ ...input, hostedReviewLookup: { revision: 3, provider: null, number: null } })
    await act(async () => {})
    expect(getEligibility).toHaveBeenCalledTimes(2)
  })

  it('waits for a pending probe and coalesces lookup publications into one recovery', async () => {
    let finish: (value: HostedReviewCreationEligibility) => void = () => {}
    const getEligibility = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<HostedReviewCreationEligibility>((resolve) => {
          finish = resolve
        })
      )
      .mockResolvedValue(dirty)
    const input = makeInput({ getHostedReviewCreationEligibility: getEligibility })
    const { result, rerender } = renderEligibility(input)

    rerender({ ...input, hostedReviewLookup: { revision: 1, provider: null, number: null } })
    rerender({ ...input, hostedReviewLookup: { revision: 2, provider: null, number: null } })
    expect(getEligibility).toHaveBeenCalledTimes(1)
    await act(async () => finish(unsupported))

    expect(getEligibility).toHaveBeenCalledTimes(2)
    expect(result.current.action?.label).toBe('Create PR')
  })

  it('does not replace a healthy result for lookup publications during its probe', async () => {
    let finish: (value: HostedReviewCreationEligibility) => void = () => {}
    const getEligibility = vi.fn().mockReturnValue(
      new Promise<HostedReviewCreationEligibility>((resolve) => {
        finish = resolve
      })
    )
    const input = makeInput({ getHostedReviewCreationEligibility: getEligibility })
    const { rerender } = renderEligibility(input)
    rerender({ ...input, hostedReviewLookup: { revision: 1, provider: null, number: null } })
    await act(async () => finish(dirty))
    expect(getEligibility).toHaveBeenCalledTimes(1)
  })

  it('clears permission to create while reconciling newly found review evidence', async () => {
    let finish: (value: HostedReviewCreationEligibility) => void = () => {}
    const getEligibility = vi
      .fn()
      .mockResolvedValueOnce({ ...dirty, blockedReason: null, canCreate: true })
      .mockReturnValueOnce(
        new Promise<HostedReviewCreationEligibility>((resolve) => {
          finish = resolve
        })
      )
    const input = makeInput({ getHostedReviewCreationEligibility: getEligibility })
    const { result, rerender } = renderEligibility(input)
    await act(async () => {})
    expect(result.current.hostedReviewCreation?.canCreate).toBe(true)

    rerender({ ...input, hostedReviewLookup: { revision: 1, provider: 'gitlab', number: 42 } })
    expect(result.current.hostedReviewCreation).toBeNull()
    expect(result.current.hostedReviewCreationRequestState?.status).toBe('loading')
    await act(async () => finish(existing))
    expect(result.current.action).toBeNull()
  })

  it.each([
    { activeRepoConnectionId: 'ssh-1', activeRepoExecutionHostId: 'ssh:ssh-1' as const },
    { activeRepoExecutionHostId: 'runtime:managed' as const },
    { activeRepoId: 'repo-2', activeRepoPath: '/other-repo' },
    { activeWorktreeId: 'wt-2', worktreePath: '/other-worktree' },
    { branchName: 'other-branch' }
  ])('isolates late responses after changing the target: %j', async (target) => {
    let finish: (value: HostedReviewCreationEligibility) => void = () => {}
    const getEligibility = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<HostedReviewCreationEligibility>((resolve) => {
          finish = resolve
        })
      )
      .mockResolvedValue(dirty)
    const input = makeInput({ getHostedReviewCreationEligibility: getEligibility })
    const { result, rerender } = renderEligibility(input)

    rerender({ ...input, ...target })
    await act(async () => {})
    await act(async () => finish(existing))

    expect(getEligibility).toHaveBeenCalledTimes(2)
    expect(result.current.hostedReviewCreation).toEqual(dirty)
    expect(result.current.action?.label).toBe('Create PR')
  })

  it('ignores a hidden panel’s late response and uses current evidence when reopened', async () => {
    let finish: (value: HostedReviewCreationEligibility) => void = () => {}
    const getEligibility = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<HostedReviewCreationEligibility>((resolve) => {
          finish = resolve
        })
      )
      .mockResolvedValue(dirty)
    const input = makeInput({ getHostedReviewCreationEligibility: getEligibility })
    const { result, rerender } = renderEligibility(input)

    rerender({ ...input, isBranchVisible: false })
    await act(async () => finish(existing))
    rerender({
      ...input,
      isBranchVisible: false,
      hostedReviewLookup: { revision: 2, provider: null, number: null }
    })
    await act(async () => {})
    expect(getEligibility).toHaveBeenCalledTimes(1)
    expect(result.current.hostedReviewCreation).toBeNull()

    rerender({ ...input, hostedReviewLookup: { revision: 2, provider: null, number: null } })
    await act(async () => {})
    expect(result.current.action?.label).toBe('Create PR')
  })

  it('keeps failed remote evidence from authorizing creation, including after recovery', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const getEligibility = vi.fn().mockRejectedValue(new Error('remote unavailable'))
    const input = makeInput({ getHostedReviewCreationEligibility: getEligibility })
    const { result, rerender } = renderEligibility(input)
    await act(async () => {})
    expect(result.current.hostedReviewCreation).toMatchObject({
      canCreate: false,
      reviewLookupOutcome: 'unavailable'
    })
    rerender({ ...input, hostedReviewLookup: { revision: 2, provider: null, number: null } })
    await act(async () => {})
    expect(getEligibility).toHaveBeenCalledTimes(2)
    expect(result.current.hostedReviewCreation).toMatchObject({
      canCreate: false,
      reviewLookupOutcome: 'unavailable'
    })
    warn.mockRestore()
  })

  it('suppresses probes for folders and review flows in flight', async () => {
    const input = makeInput({ isFolder: true })
    const { rerender } = renderEligibility(input)
    await act(async () => {})
    rerender({
      ...input,
      isFolder: false,
      isCreatingPr: true,
      hostedReviewLookup: { revision: 1, provider: null, number: null }
    })
    await act(async () => {})
    expect(input.getHostedReviewCreationEligibility).not.toHaveBeenCalled()
  })
})
