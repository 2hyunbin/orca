import type { AiVaultSessionPreviewMessage } from '../../shared/ai-vault-types'
import { timestampIso } from './session-scanner-accumulator'
import {
  extractFullFirstUserPromptText,
  shouldCaptureFullFirstUserPrompt
} from './session-scanner-first-user-prompt'
import {
  extractPreviewContentText,
  normalizePreviewText
} from './session-scanner-text-normalization'
import type { SessionAccumulator } from './session-scanner-types'
import { transcriptMessagesFromDecodedMessage } from './session-transcript-message-content'
import { decodeSessionMessage, type DecodedSessionMessage } from './session-decoded-message'

const SESSION_PREVIEW_MESSAGE_LIMIT = 5

export function addSessionContent(
  accumulator: SessionAccumulator,
  role: AiVaultSessionPreviewMessage['role'],
  content: unknown,
  timestamp?: unknown,
  options?: { seedFirstUserPrompt?: boolean }
): boolean {
  return addDecodedSessionMessage(
    accumulator,
    decodeSessionMessage(role, content, timestampIso(timestamp), {
      includeTools: accumulator.messages.active
    }),
    options
  )
}

export function addSessionText(
  accumulator: SessionAccumulator,
  args: {
    role: AiVaultSessionPreviewMessage['role']
    text: string | null
    timestamp?: unknown
    seedFirstUserPrompt?: boolean
  }
): void {
  addSessionContent(accumulator, args.role, args.text, args.timestamp, args)
}

export function addDecodedSessionMessage(
  accumulator: SessionAccumulator,
  message: DecodedSessionMessage,
  options?: { seedFirstUserPrompt?: boolean }
): boolean {
  const textParts = message.blocks.flatMap((block) => (block.kind === 'text' ? [block.text] : []))
  if (
    message.role === 'user' &&
    options?.seedFirstUserPrompt !== false &&
    !accumulator.firstUserPrompt &&
    shouldCaptureFullFirstUserPrompt()
  ) {
    accumulator.firstUserPrompt = extractFullFirstUserPromptText(textParts)
  }
  if (accumulator.messages.active) {
    for (const transcript of transcriptMessagesFromDecodedMessage(message)) {
      accumulator.messages.push(transcript)
    }
  }
  return addPreviewMessage(accumulator, {
    role: message.role,
    text: extractPreviewContentText(textParts, message.role),
    timestamp: message.timestamp
  })
}

export function addPreviewMessage(
  accumulator: SessionAccumulator,
  message: { role: AiVaultSessionPreviewMessage['role']; text: string | null; timestamp?: unknown }
): boolean {
  const text = normalizePreviewText(message.text ?? '', message.role)
  if (!text) {
    return false
  }
  accumulator.previewMessages.push({
    role: message.role,
    text,
    timestamp: timestampIso(message.timestamp)
  })
  if (accumulator.previewMessages.length > SESSION_PREVIEW_MESSAGE_LIMIT) {
    accumulator.previewMessages.shift()
    accumulator.previewMessagesTruncated = true
  }
  return true
}
