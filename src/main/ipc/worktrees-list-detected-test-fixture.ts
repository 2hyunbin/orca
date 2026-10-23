import type { DetectedWorktreeListResult } from '../../shared/worktree/types'

function isDetectedWorktreeListResult(value: unknown): value is DetectedWorktreeListResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'authoritative' in value &&
    typeof value.authoritative === 'boolean' &&
    'worktrees' in value &&
    Array.isArray(value.worktrees)
  )
}

export function expectDetectedWorktreeListResult(value: unknown): DetectedWorktreeListResult {
  if (!isDetectedWorktreeListResult(value)) {
    throw new Error(`Expected a detected worktree list result, got ${JSON.stringify(value)}`)
  }
  return value
}
