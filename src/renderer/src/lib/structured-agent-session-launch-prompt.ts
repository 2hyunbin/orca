import { handBackStagedPrompt } from './structured-agent-session-launch-prompt-return'
import type { StructuredAgentLaunchReceipt } from './structured-agent-session-launch-recovery'
import type { StructuredAgentSessionFirstMessage } from '../../../shared/structured-agent-session-create'
import { StructuredAgentSessionCreateRefusalError, StructuredAgentSessionSubmissionEndedError } from './structured-agent-session-launch-errors'
import { agentSessionThrownFailure } from '../../../shared/agent-session-write-failure'
import {
  dropStructuredAgentSessionSends,
  reserveStructuredAgentSessionSend,
  sendStructuredAgentSessionMessage
} from '@/components/native-chat/structured-agent-session-message-sender'
import { noteStructuredAgentSessionFence } from '@/components/native-chat/structured-agent-session-send-attempt'
import { publishStructuredAgentSessionSends } from '@/components/native-chat/structured-agent-session-pending-sends'
import { agentSessionWriteNoticeText } from '@/components/native-chat/agent-session-write-notice-text'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { StructuredAgentSessionSendInput } from '@/components/native-chat/structured-agent-session-send-slot'
import type { NativeChatComposerDraft } from '@/components/native-chat/native-chat-composer-draft-storage'

import type { StructuredPromptDeliveryResult, StructuredLaunchPromptOptions, StagedDelivery, StagedStructuredLaunchPrompt } from './structured-agent-session-launch-prompt-types'
export type { StructuredPromptDeliveryResult, StructuredLaunchPromptOptions, StagedStructuredLaunchPrompt } from './structured-agent-session-launch-prompt-types'
type LaunchReceipt = StructuredAgentLaunchReceipt

const staged = new Map<string, Set<StagedStructuredLaunchPrompt>>()

export function stageStructuredLaunchPrompt(
  sessionId: string,
  text: string,
  options: { callerKeepsText?: true; sourceDraft?: NativeChatComposerDraft } & Pick<StructuredAgentSessionSendInput, 'attachments' | 'options'> = {}
): StagedStructuredLaunchPrompt {
  let discard = (): void => {}
  const whenDiscarded = new Promise<void>((resolve) => {
    discard = resolve
  })
  let settleCreate = (_outcome: StagedDelivery): void => {}
  const whenCreateSettled = new Promise<StagedDelivery>((resolve) => {
    settleCreate = resolve
  })
  const prompt: StagedStructuredLaunchPrompt = {
    sessionId,
    text,
    slot: reserveStructuredAgentSessionSend({ sessionId, text, ...options,
      ...(options.sourceDraft ? { callerKeepsText: true as const } : {}) }),
    ...options,
    whenDiscarded,
    discard,
    whenCreateSettled,
    settleCreate
  }
  const forSession = staged.get(sessionId) ?? new Set()
  forSession.add(prompt)
  staged.set(sessionId, forSession)
  void prompt.slot?.outcome.then((outcome) => {
    if (!prompt.discarded && prompt.sourceDraft && (outcome === 'returned' || outcome === 'unconfirmed')) handBackStagedPrompt(prompt)
    const result: StagedDelivery = {
      delivered: outcome === 'recorded',
      inComposer: !prompt.callerKeepsText && (outcome === 'returned' || outcome === 'unconfirmed'),
      ...(outcome === 'unconfirmed' ? { unconfirmed: true } : {})
    }
    if (!prompt.delivery) {
      prompt.delivery = Promise.resolve(result)
      unstage(prompt)
    }
    prompt.settleCreate(result)
  })
  return prompt
}

function unstage(prompt: StagedStructuredLaunchPrompt): void {
  prompt.slot?.release()
  const forSession = staged.get(prompt.sessionId)
  forSession?.delete(prompt)
  if (forSession?.size === 0) {
    staged.delete(prompt.sessionId)
  }
}

/** The launch was cancelled: what it staged is dropped with its chat. */
export function discardStructuredLaunchPrompts(sessionId: string): void {
  for (const prompt of staged.get(sessionId) ?? []) {
    prompt.slot?.release()
    prompt.discarded = true
    prompt.discard()
  }
  staged.delete(sessionId)
}

/** The chat is closing or its launch was cancelled: nothing it was sending goes out any more. */
export function discardStructuredAgentSessionChatSends(sessionId: string): void {
  discardStructuredLaunchPrompts(sessionId)
  dropStructuredAgentSessionSends(sessionId)
}

/** A Stop before the chat is published: text its launch has not sent goes back to the composer,
 *  never sent. The start itself goes on. */
export function takeBackLegacyStructuredLaunchPrompts(sessionId: string): void {
  for (const prompt of staged.get(sessionId) ?? []) {
    if (prompt.delivery || prompt.createOwned) {
      continue
    }
    unstage(prompt)
    handBackStagedPrompt(prompt)
    prompt.discarded = true
    prompt.discard()
  }
}

export function prepareLegacyStructuredLaunchPrompts(sessionId: string): void {
  for (const prompt of staged.get(sessionId) ?? []) {
    prompt.slot?.legacy()
  }
}

/** Transfers the first staged prompt to create, retaining the sender's deadline and bubble. */
export function prepareStructuredLaunchPromptForCreate(
  sessionId: string,
  target: RuntimeClientTarget,
  ownedPrompt?: StagedStructuredLaunchPrompt
): StructuredAgentSessionFirstMessage | undefined {
  const prompt = ownedPrompt ?? [...(staged.get(sessionId) ?? [])].find(
    (candidate) => !candidate.discarded && !candidate.delivery
  )
  if (!prompt) {
    return undefined
  }
  prompt.createOwned = true
  const sent = prompt.slot?.create(target, ownedPrompt ? true : undefined)
  prompt.createSend = sent ?? undefined
  prompt.delivery = sent
    ? sent.outcome.then((outcome) => {
        unstage(prompt)
        return {
          delivered: outcome === 'recorded',
          inComposer:
            !prompt.callerKeepsText && (outcome === 'returned' || outcome === 'unconfirmed'),
          ...(outcome === 'unconfirmed' ? { unconfirmed: true as const } : {})
        }
      })
    : Promise.resolve({ delivered: false, inComposer: !prompt.callerKeepsText }).then((outcome) => {
        unstage(prompt)
        return outcome
      })
  void prompt.delivery.then(prompt.settleCreate)
  return sent?.message
}

/** Whether a launch still holds text for this chat that has not reached its host. */
export function hasStagedStructuredLaunchPrompt(sessionId: string): boolean {
  return (staged.get(sessionId)?.size ?? 0) > 0
}


function sendStagedPrompt(
  prompt: StagedStructuredLaunchPrompt,
  receipt: LaunchReceipt | undefined,
  target: RuntimeClientTarget
): Promise<StagedDelivery> {
  prompt.delivery ??= (async () => {
    if (receipt) noteStructuredAgentSessionFence(prompt.sessionId, receipt.fence)
    if (prompt.sourceDraft && !prompt.slot?.prepare()) throw new StructuredAgentSessionSubmissionEndedError()
    await prompt.beforeSend?.()
    const sent =
      prompt.slot ? prompt.slot.send(target) :
      sendStructuredAgentSessionMessage({ sessionId: prompt.sessionId, target, text: prompt.text })
    if (!sent) {
      // Another send of the chat holds its slot: the launch text waits in the composer instead.
      unstage(prompt)
      return { delivered: false, inComposer: handBackStagedPrompt(prompt), busy: true }
    }
    try {
      const outcome = await sent.outcome
      return {
        delivered: outcome === 'recorded',
        inComposer:
          !prompt.callerKeepsText && (outcome === 'returned' || outcome === 'unconfirmed'),
        ...(outcome === 'unconfirmed' ? { unconfirmed: true as const } : {})
      }
    } finally {
      unstage(prompt)
    }
  })()
  return prompt.delivery
}

/** A later explicit Send continues the hosted chat through the same reserved sender. */
export function deliverStructuredLaunchPromptToExistingSession(
  prompt: StagedStructuredLaunchPrompt,
  target: RuntimeClientTarget
): Promise<StagedDelivery> {
  return sendStagedPrompt(prompt, undefined, target).catch(() => {
    failStagedStructuredLaunchPrompt(prompt)
    return { delivered: false, inComposer: true }
  })
}

/** Captures the original reservation; late preparation never adopts a newer send. */
export async function prepareStructuredLaunchFirstSubmission(
  sessionId: string,
  clientMessageId: string,
  target: RuntimeClientTarget,
  atomic: boolean
): Promise<() => StructuredAgentSessionFirstMessage | undefined> {
  const prompt = [...(staged.get(sessionId) ?? [])].find(
    (candidate) => candidate.slot?.clientMessageId === clientMessageId
  )
  if (!prompt?.slot?.prepare()) throw new StructuredAgentSessionSubmissionEndedError()
  await prompt.beforeCreate?.()
  return () => {
    if (!prompt.slot?.prepare()) throw new StructuredAgentSessionSubmissionEndedError()
    if (!atomic || prompt.beforeSend) return undefined
    const message = prepareStructuredLaunchPromptForCreate(sessionId, target, prompt)
    if (!message) throw new StructuredAgentSessionSubmissionEndedError()
    return message
  }
}

export function failStagedStructuredLaunchPrompt(prompt: StagedStructuredLaunchPrompt): void {
  if (prompt.discarded) return
  unstage(prompt)
  handBackStagedPrompt(prompt)
  prompt.settleCreate({ delivered: false, inComposer: true })
  publishStructuredAgentSessionSends(prompt.sessionId, { notice: agentSessionWriteNoticeText(['notDoneSend']) })
}

export function settleStructuredAgentLaunchPrompt(args: {
  launchResult: Promise<LaunchReceipt>
  target: RuntimeClientTarget
  options: StructuredLaunchPromptOptions
  stagedPrompt: StagedStructuredLaunchPrompt | null
}): Promise<StructuredPromptDeliveryResult> | undefined {
  // Why: a draft has no delivery event — the composer adopts it and the user sends it — so
  // `onPromptDelivered` never fires and no result is reported.
  if (args.options.promptDelivery === 'draft' || (!args.options.prompt?.trim() && !args.stagedPrompt)) {
    return undefined
  }
  const prompt = args.stagedPrompt
  const settled = args.launchResult.then(
    async (receipt) => {
      if (!prompt || prompt.discarded) {
        return { delivered: false, failureNotified: true }
      }
      if (prompt.createOwned) {
        prompt.createSend?.settle(
          receipt.firstMessage
            ? { kind: 'recorded', submission: receipt.firstMessage, cursor: receipt.cursor }
            : { kind: 'unconfirmed' }
        )
      }
      const { delivered, inComposer, unconfirmed, busy } = await sendStagedPrompt(
        prompt,
        receipt,
        args.target
      ).catch(() => {
        failStagedStructuredLaunchPrompt(prompt)
        return { delivered: false, inComposer: true }
      })
      return {
        delivered,
        failureNotified: false,
        ...(inComposer ? { inComposer: true as const } : {}),
        ...(unconfirmed ? { unconfirmed } : {}),
        ...(busy ? { busy } : {})
      }
    },
    (error: unknown) => {
      if (prompt?.createOwned) {
        prompt.createSend?.settle(
          error instanceof StructuredAgentSessionCreateRefusalError
            ? { kind: 'refused', failure: agentSessionThrownFailure(error, error.code) }
            : { kind: 'unconfirmed' }
        )
      }
      // The chat never started: its text waits in the chat's composer for the person's own Send.
      if (prompt && !prompt.discarded && !prompt.delivery) {
        unstage(prompt)
        handBackStagedPrompt(prompt)
        prompt.discarded = true
      }
      throw error
    }
  )
  const result = prompt
    ? Promise.race([
        settled,
        prompt.whenCreateSettled.then(({ inComposer, ...outcome }) => ({
          ...outcome,
          failureNotified: false,
          ...(inComposer ? { inComposer: true as const } : {})
        })),
        prompt.whenDiscarded.then((): StructuredPromptDeliveryResult => ({
          delivered: false,
          failureNotified: true
        }))
      ])
    : settled
  return result.then((outcome) => {
    if (outcome.delivered) {
      args.options.onPromptDelivered?.()
    }
    return outcome
  })
}
