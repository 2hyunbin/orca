import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  IMPORTED_WORKTREES_KEEP_HIDDEN_ERROR,
  keepImportedWorktreesHiddenCard,
  type ImportedWorktreeCardActionState
} from './imported-worktrees-card-actions'

const projectId = 'repo-1'

describe('imported worktrees card actions', () => {
  const updateRepo = vi.fn()
  const setCardState =
    vi.fn<(projectId: string, state: ImportedWorktreeCardActionState | null) => void>()

  beforeEach(() => {
    vi.clearAllMocks()
    updateRepo.mockResolvedValue(true)
  })

  it('dismisses the card when keep-hidden update succeeds', async () => {
    await keepImportedWorktreesHiddenCard({
      projectId,
      updateRepo,
      setCardState,
      hiddenWorktreePaths: ['/scratch/external'],
      existingBaselinePaths: ['/scratch/old']
    })

    expect(updateRepo).toHaveBeenCalledWith(projectId, {
      externalWorktreeVisibilityPromptDismissedAt: expect.any(Number),
      externalWorktreeDiscoverySuppressedAt: expect.any(Number),
      externalWorktreeInboxBaselinePaths: ['/scratch/old', '/scratch/external']
    })
    expect(setCardState).toHaveBeenLastCalledWith(projectId, null)
  })

  it('leaves the card visible when keep-hidden update fails', async () => {
    updateRepo.mockResolvedValueOnce(false)

    await keepImportedWorktreesHiddenCard({ projectId, updateRepo, setCardState })

    expect(setCardState).toHaveBeenLastCalledWith(projectId, {
      pending: false,
      error: IMPORTED_WORKTREES_KEEP_HIDDEN_ERROR
    })
  })
})
