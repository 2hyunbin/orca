import type { AgentGenerationFailureOutput } from '../text-generation/agent-failure-output'
import type { FirstWorkBranchRenameDeps } from './first-work-branch-rename'

// Why: every "working" event re-runs a failed name generation, so an agent stuck on a usage limit
// spawned hundreds of sessions (#9705); space retries out and give up after a few.
export const FIRST_WORK_GENERATION_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000]

type GenerationFailures = { count: number; retryAt: number }

const failuresByWorkspace = new Map<string, GenerationFailures>()

export function resetFirstWorkGenerationBackoff(): void {
  failuresByWorkspace.clear()
}

export function isFirstWorkGenerationBackingOff(workspaceId: string, now = Date.now()): boolean {
  const failures = failuresByWorkspace.get(workspaceId)
  return failures !== undefined && now < failures.retryAt
}

/** Returns false once the retry schedule is spent and the workspace should stop trying. */
function recordFirstWorkGenerationFailure(workspaceId: string, now = Date.now()): boolean {
  const count = (failuresByWorkspace.get(workspaceId)?.count ?? 0) + 1
  const delay = FIRST_WORK_GENERATION_RETRY_DELAYS_MS[count - 1]
  if (delay === undefined) {
    failuresByWorkspace.delete(workspaceId)
    return false
  }
  failuresByWorkspace.set(workspaceId, { count, retryAt: now + delay })
  return true
}

export function clearFirstWorkGenerationFailures(workspaceId: string): void {
  failuresByWorkspace.delete(workspaceId)
}

/** Failed generations retry on a bounded schedule; the error badge stays once it is spent. */
export function retryFailedGeneration(
  worktreeId: string,
  generated: { error: string; canceled?: boolean; failureOutput?: AgentGenerationFailureOutput },
  deps: Pick<FirstWorkBranchRenameDeps, 'setRenameError'>,
  stop: (reason: string) => true,
  retry: (reason: string) => false
): boolean {
  if (generated.canceled) {
    return retry(`generation canceled: ${generated.error}`)
  }
  deps.setRenameError(worktreeId, generated.error, generated.failureOutput ?? null)
  return recordFirstWorkGenerationFailure(worktreeId)
    ? retry(`generation failed: ${generated.error}`)
    : stop(`generation failed too many times: ${generated.error}`)
}
