import {
  readNativeChatNewDraft
} from '@/components/native-chat/native-chat-new-draft'
import { readNativeChatComposerDraft } from '@/components/native-chat/native-chat-composer-draft-store'
import {
  stageStructuredLaunchPrompt,
  deliverStructuredLaunchPromptToExistingSession
} from './structured-agent-session-launch-prompt'
import { startStructuredAgentLaunch } from './structured-agent-session-launch'
import { newAgentLaunchRequestId } from './agent-launch-request-id'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import {
  prepareNativeChatSessionAttachmentUpload,
  resolveNativeChatRuntimeSessionAttachmentOwner,
  uploadNativeChatSessionAttachmentPaths
} from '@/components/native-chat/native-chat-attachment-upload'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import type { StructuredAgentSessionAttachment } from '../../../shared/structured-agent-session-send-mutation'
import { getStructuredLaunchStateBySessionId, getPersistedStructuredAgentLaunchRecord } from './structured-agent-session-launch-registry'
import { confirmStructuredLaunchFirstMessagePublication } from './structured-agent-session-launch-publication-confirmation'

/** Uses the existing launch reservation for the complete immutable opening submission. */
export function submitNativeChatLocalDraft(
  sessionId: string,
  text: string,
  attachments: readonly StructuredAgentSessionAttachment[],
  options: Readonly<Record<string, string>>,
  hosted = false
): boolean {
  const draft = readNativeChatNewDraft(sessionId)
  if (!draft) return false
  const prior = getStructuredLaunchStateBySessionId(sessionId)
  const issued = prior?.intent.firstSubmission ?? getPersistedStructuredAgentLaunchRecord(sessionId)?.firstSubmission
  if (!hosted && issued && prior?.callers.outcome !== 'failed') {
    confirmStructuredLaunchFirstMessagePublication(draft.owner.workspaceId, sessionId)
    return false
  }
  const sourceDraft = readNativeChatComposerDraft(`agent-session:${sessionId}`)
  const stagedPrompt = stageStructuredLaunchPrompt(sessionId, text, { attachments, options, sourceDraft })
  if (!stagedPrompt.slot) return false
  const prepare = async (): Promise<void> => {
    const target = structuredAgentSessionTargetForHost(draft.owner.executionHostId)
    if (!target) throw new Error('The chat host is unavailable.')
    if (target.kind === 'environment' && attachments.length > 0) {
      const owner = resolveNativeChatRuntimeSessionAttachmentOwner({ sessionId, runtimeEnvironmentId: target.environmentId }, false)
      if (owner.kind !== 'runtime-session') throw new Error('The chat host is unavailable.')
      const prepared = await prepareNativeChatSessionAttachmentUpload(owner, hosted ? undefined : {
        worktree: toRuntimeWorktreeSelector(draft.owner.workspaceId), agent: draft.agent
      })
      if (!prepared.ok) throw new Error(prepared.notice)
      const upload = async (): Promise<void> => {
        const result = await uploadNativeChatSessionAttachmentPaths(attachments.map((image) => image.path), prepared.target)
        if (result.failed.length || result.skipped.length || result.uploaded.length !== attachments.length) {
          throw new Error('The images could not be attached. Attach them again and send.')
        }
        const stored = new Map(result.uploaded.map((image) => [image.sourcePath, image.path]))
        stagedPrompt.slot?.setAttachments(attachments.map((image) => {
          const path = stored.get(image.path)
          if (!path) throw new Error('The images could not be attached. Attach them again and send.')
          return { ...image, path }
        }))
      }
      if (hosted || prepared.target.reservedSession) await upload()
      else stagedPrompt.beforeSend = upload
    }
  }
  if (hosted) {
    const target = structuredAgentSessionTargetForHost(draft.owner.executionHostId)
    if (!target) { stagedPrompt.slot.release(); return false }
    stagedPrompt.beforeSend = prepare
    void deliverStructuredLaunchPromptToExistingSession(stagedPrompt, target)
    return true
  }
  stagedPrompt.beforeCreate = prepare
  const launch = startStructuredAgentLaunch(draft.owner.workspaceId, draft.agent, {
      requestId: newAgentLaunchRequestId(), executionHostId: draft.owner.executionHostId,
      reservedSessionId: sessionId, stagedPrompt, prompt: text, firstSubmissionOptions: options
    })
  void launch.launchResult.catch(() => {})
  return true
}
