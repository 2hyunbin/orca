import { cancelRuntimeGenerateCommitMessage } from '@/runtime/runtime-git-generation-client'
import {
  resolveCommitMessageGenerationCancel,
  type CommitMessageGenerationRecord,
  type CommitMessageGenerationSlice
} from '@/store/slices/commit-message-generation'
import type { CreatePrIntentRunToken } from '../review/create-pr-intent-flow'

export function cancelCommitMessageGenerationRequest({
  key,
  worktreeId,
  worktreePath,
  record,
  inFlight,
  intentTokens,
  updateRecord
}: {
  key: string | null
  worktreeId: string | null
  worktreePath: string | null
  record: CommitMessageGenerationRecord | null
  inFlight: Record<string, boolean>
  intentTokens: Record<string, CreatePrIntentRunToken | null>
  updateRecord: CommitMessageGenerationSlice['updateCommitMessageGenerationRecord']
}): void {
  if (!key || !worktreeId || !worktreePath || !inFlight[worktreeId]) {
    return
  }
  const context =
    intentTokens[worktreeId]?.commitMessageGeneration ??
    (record?.context ? { ...record.context, target: record.context.runtimeTarget } : undefined)
  if (context?.generationCancellation) {
    context.generationCancellation.canceled = true
  }
  updateRecord(key, resolveCommitMessageGenerationCancel)
  if (!context) {
    return
  }
  // The in-flight promise clears the spinner after the original owner settles.
  void cancelRuntimeGenerateCommitMessage({
    target: context.target,
    worktreeId: context.worktreeId,
    worktreePath: context.worktreePath,
    connectionId: context.connectionId,
    generationId: context.generationId
  })
}
