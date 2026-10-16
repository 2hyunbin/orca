import { structuredAgentSessionSendBody } from '../../../shared/structured-agent-session-send-mutation'
import { handBackStructuredAgentSessionMessage } from '@/components/native-chat/structured-agent-session-message-hand-back'
import { publishStructuredAgentSessionSends } from '@/components/native-chat/structured-agent-session-pending-sends'
import { agentSessionWriteNoticeText } from '@/components/native-chat/agent-session-write-notice-text'

import type { StructuredAgentLaunchReceipt } from './structured-agent-session-launch-recovery'
import type { StructuredAgentSessionFirstMessage } from '../../../shared/structured-agent-session-create'
import { StructuredAgentSessionCreateRefusalError, StructuredAgentSessionSubmissionEndedError } from './structured-agent-session-launch-errors'
import { structuredLaunchFailure } from './structured-agent-session-launch-failure'
import {
  dropStructuredAgentSessionSends,
  reserveStructuredAgentSessionSend,
  sendStructuredAgentSessionMessage,
  type StructuredAgentSessionCreateSend,
  type StructuredAgentSessionSendOutcome,
  type StructuredAgentSessionReservedSend
} from '@/components/native-chat/structured-agent-session-message-sender'
import { noteStructuredAgentSessionFence } from '@/components/native-chat/structured-agent-session-send-attempt'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { StructuredAgentSessionSendInput } from '@/components/native-chat/structured-agent-session-send-slot'
import { projectNativeChatComposerDraft, type NativeChatComposerDraft } from '@/components/native-chat/native-chat-composer-draft-storage'

export type StructuredPromptDeliveryResult = {
  delivered: boolean
  failureNotified: boolean
  /** Not sent, and waiting in the new chat's composer, which now owns the text. */
  inComposer?: true
  /** Nobody could confirm it went: the host may hold it. */
  unconfirmed?: true
  /** Another send of the chat held its one slot, so this one never went. */
  busy?: true
}

type StagedDelivery = Omit<StructuredPromptDeliveryResult, 'inComposer' | 'failureNotified'> & {
  inComposer: boolean
}

export type StructuredLaunchPromptOptions = {
  prompt?: string
  promptDelivery?: 'auto-submit' | 'submit-after-ready' | 'draft'
  onPromptDelivered?: () => void
}

/** A launch's text, held in memory from the click until its chat exists, then sent once: every
 *  caller waiting on it shares the one send. From the click it holds the chat's one send slot, drawn
 *  as sending, so nothing typed meanwhile goes out ahead of it. */
export type StagedStructuredLaunchPrompt = {
  sessionId: string
  text: string
  slot: StructuredAgentSessionReservedSend | null
  sourceDraft?: NativeChatComposerDraft
  options?: Readonly<Record<string, string>>
  beforeCreate?: () => Promise<void>
  beforeSend?: () => Promise<void>
  /** Its sender keeps the text if it comes back (notes), instead of the chat's composer. */
  callerKeepsText?: true
  delivery?: Promise<StagedDelivery>
  /** Create owns this prompt; it must never become a later send. */
  createOwned?: true
  createSend?: StructuredAgentSessionCreateSend
  whenCreateSettled: Promise<StagedDelivery>
  settleCreate: (outcome: StagedDelivery) => void
  /** Its launch was cancelled: never sent, never given back. */
  discarded?: true
  /** Settles once it is discarded, so its callers need not wait on a create that may never end. */
  whenDiscarded: Promise<void>
  discard: () => void
}

const staged = new Map<string, Set<StagedStructuredLaunchPrompt>>()

export function stageStructuredLaunchPrompt(
  sessionId: string,
  text: string,
  options: { callerKeepsText?: true; sourceDraft?: NativeChatComposerDraft } & Pick<StructuredAgentSessionSendInput, 'attachments' | 'options'> = {}
): StagedStructuredLaunchPrompt {
  const source = options.sourceDraft ? { sourceDraft: projectNativeChatComposerDraft(options.sourceDraft) } : {}
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
    slot: reserveStructuredAgentSessionSend({ sessionId, text, ...options, ...source }),
    ...options,
    ...source,
    whenDiscarded,
    discard,
    whenCreateSettled,
    settleCreate
  }
  const forSession = staged.get(sessionId) ?? new Set()
  forSession.add(prompt)
  staged.set(sessionId, forSession)
  void prompt.slot?.outcome.then((outcome) => {
    const result = stagedPromptDelivery(prompt, outcome)
    if (!prompt.delivery) {
      prompt.delivery = Promise.resolve(result)
      releaseStagedStructuredLaunchPrompt(prompt)
    }
    prompt.settleCreate(result)
  })
  return prompt
}

export function releaseStagedStructuredLaunchPrompt(prompt: StagedStructuredLaunchPrompt): void {
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
    if (prompt.slot) {
      prompt.slot.release(null)
    } else {
      handBackStagedPrompt(prompt)
    }
    releaseStagedStructuredLaunchPrompt(prompt)
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
  prompt.delivery = (sent?.outcome ?? Promise.resolve('returned' as const)).then((outcome) => {
    releaseStagedStructuredLaunchPrompt(prompt)
    return stagedPromptDelivery(prompt, outcome)
  })
  void prompt.delivery.then(prompt.settleCreate)
  return sent?.message
}

/** Whether a launch still holds text for this chat that has not reached its host. */
export function hasStagedStructuredLaunchPrompt(sessionId: string): boolean {
  return (staged.get(sessionId)?.size ?? 0) > 0
}

/** Puts a launch's text in its chat's composer, unless its sender keeps it. True when it did; a
 *  draft write that throws is reported in the chat instead, and never stops its caller. */
function handBackStagedPrompt(prompt: StagedStructuredLaunchPrompt): boolean {
  if (prompt.callerKeepsText || prompt.discarded) {
    return false
  }
  try {
    handBackStructuredAgentSessionMessage(
      prompt.sessionId,
      `launch-${prompt.sessionId}`,
      structuredAgentSessionSendBody(prompt.text, [])
    )
    return true
  } catch (error) {
    console.error(
      '[native-chat-send] a launch message could not be put back in the composer',
      error
    )
    publishStructuredAgentSessionSends(prompt.sessionId, {
      notice: agentSessionWriteNoticeText(['messageNotSaved'])
    })
    return false
  }
}

function stagedPromptDelivery(
  prompt: StagedStructuredLaunchPrompt,
  outcome: StructuredAgentSessionSendOutcome
): StagedDelivery {
  return {
    delivered: outcome === 'recorded',
    inComposer: !prompt.callerKeepsText && (outcome === 'returned' || outcome === 'unconfirmed'),
    ...(outcome === 'unconfirmed' ? { unconfirmed: true as const } : {})
  }
}

function failStagedStructuredLaunchPrompt(prompt: StagedStructuredLaunchPrompt): void {
  if (prompt.discarded) {
    return
  }
  if (prompt.slot) {
    prompt.slot.release(['notDoneSend'])
  } else {
    handBackStagedPrompt(prompt)
  }
  releaseStagedStructuredLaunchPrompt(prompt)
  prompt.settleCreate({ delivered: false, inComposer: true })
}

function sendStagedPrompt(
  prompt: StagedStructuredLaunchPrompt,
  receipt: StructuredAgentLaunchReceipt,
  target: RuntimeClientTarget
): Promise<StagedDelivery> {
  prompt.delivery ??= (async () => {
    noteStructuredAgentSessionFence(prompt.sessionId, receipt.fence)
    if (prompt.sourceDraft && !prompt.slot?.prepare()) {
      throw new StructuredAgentSessionSubmissionEndedError()
    }
    await prompt.beforeSend?.()
    const sent =
      prompt.slot ? prompt.slot.send(target) :
      sendStructuredAgentSessionMessage({ sessionId: prompt.sessionId, target, text: prompt.text })
    if (!sent) {
      // Another send of the chat holds its slot: the launch text waits in the composer instead.
      releaseStagedStructuredLaunchPrompt(prompt)
      return { delivered: false, inComposer: handBackStagedPrompt(prompt), busy: true }
    }
    try {
      return stagedPromptDelivery(prompt, await sent.outcome)
    } finally {
      releaseStagedStructuredLaunchPrompt(prompt)
    }
  })()
  return prompt.delivery
}

export function settleStructuredAgentLaunchPrompt(args: {
  launchResult: Promise<StructuredAgentLaunchReceipt>
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
      ).catch((): StagedDelivery => {
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
            ? { kind: 'refused', failure: structuredLaunchFailure(error) ?? { kind: 'failed' } }
            : { kind: 'unconfirmed' }
        )
      }
      // The chat never started: its text waits in the chat's composer for the person's own Send.
      if (prompt && !prompt.discarded && !prompt.delivery) {
        failStagedStructuredLaunchPrompt(prompt)
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
