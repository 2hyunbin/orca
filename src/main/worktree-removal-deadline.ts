import type { RemoveWorktreeResult } from '../shared/worktree/create-types'
import { withWorktreeRemoveStageSpan } from './observability/instrumentation'
import type { BackgroundWorktreeRemovalJob } from './worktree-background-removal'
import type { WorktreeRemovalRecord } from './worktree-removal-records'

// The request returned at acceptance, so log progress and fail a stuck delete rather than let it run unseen.
export const BACKGROUND_REMOVAL_DEADLINE_MS = 30 * 60_000
const BACKGROUND_REMOVAL_PROGRESS_LOG_MS = 60_000

export async function runWithRemovalDeadline(
  record: WorktreeRemovalRecord,
  job: Pick<BackgroundWorktreeRemovalJob, 'run'>,
  stopSignal: AbortSignal
): Promise<RemoveWorktreeResult> {
  const startedAt = Date.now()
  const deadline = new AbortController()
  const deadlineTimer = setTimeout(
    () =>
      deadline.abort(
        new Error(
          `Deleting ${record.worktreePath} did not finish within ${BACKGROUND_REMOVAL_DEADLINE_MS / 60_000} minutes.`
        )
      ),
    BACKGROUND_REMOVAL_DEADLINE_MS
  )
  const progressTimer = setInterval(() => {
    console.warn(
      `[worktrees] background removal of ${record.worktreePath} still running after ${Math.round((Date.now() - startedAt) / 1000)}s`
    )
  }, BACKGROUND_REMOVAL_PROGRESS_LOG_MS)
  try {
    return await withWorktreeRemoveStageSpan('background', 'local', () =>
      job.run(AbortSignal.any([stopSignal, deadline.signal]))
    )
  } finally {
    clearTimeout(deadlineTimer)
    clearInterval(progressTimer)
  }
}
