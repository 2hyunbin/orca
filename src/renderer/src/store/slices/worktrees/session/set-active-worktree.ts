import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { createWorkspaceActivation } from './workspace-activation'

export function createSetActiveWorktree(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['setActiveWorktree'] {
  return createWorkspaceActivation(set, get)
}
