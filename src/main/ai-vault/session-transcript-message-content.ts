import { asRecord } from './session-scanner-record-value'
import { sliceAtCodeUnitLimit } from './session-scanner-text-normalization'
import type { AiVaultSessionPreviewMessage } from '../../shared/ai-vault-types'
import type { TranscriptMessage, TranscriptMessageRole } from './session-transcript-consumers'

// Safety bound only: a consumer applies its own caps. Matches the first-prompt
// copy path's ceiling so one pathological paste cannot dominate a scan.
const TRANSCRIPT_MESSAGE_TEXT_LIMIT = 256 * 1024
const TOOL_ARGUMENT_SCAN_LIMIT = 2000

const TEXT_BLOCK_TYPES = new Set(['text', 'input_text', 'output_text', 'thinking', 'reasoning'])
// The argument that identifies what a tool call actually did.
const TOOL_INPUT_KEYS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'description']

type PreviewRole = AiVaultSessionPreviewMessage['role']
type TranscriptText = { text: string | null; textTruncated: boolean }

/** Only conversational roles reach consumers; system/unknown turns are noise. */
export function transcriptMessageRole(role: PreviewRole): TranscriptMessageRole | null {
  return role === 'user' || role === 'assistant' || role === 'tool' ? role : null
}

export function toolCallContent(name: unknown, input: unknown): TranscriptText {
  const toolName = typeof name === 'string' && name.trim() ? name.trim() : null
  const inputRecord = asRecord(input)
  let argument: string | null = null
  if (inputRecord) {
    for (const key of TOOL_INPUT_KEYS) {
      const value = inputRecord[key]
      if (typeof value === 'string' && value.trim()) {
        argument = value
        break
      }
    }
  } else if (typeof input === 'string' && input.trim()) {
    argument = input
  }
  if (!toolName && !argument) {
    return { text: null, textTruncated: false }
  }
  const bounded = argument ? sliceAtCodeUnitLimit(argument, TOOL_ARGUMENT_SCAN_LIMIT) : null
  return {
    text: toolName && bounded ? `${toolName}: ${bounded}` : (toolName ?? bounded),
    textTruncated: argument !== null && bounded !== null && bounded.length < argument.length
  }
}

/** Flattens a tool_result body (a string, or an array of text blocks). */
function toolResultText(content: unknown): TranscriptText {
  if (typeof content === 'string') {
    return { text: content.trim() ? content : null, textTruncated: false }
  }
  if (!Array.isArray(content)) {
    return { text: null, textTruncated: false }
  }
  const parts: string[] = []
  let length = 0
  let omitted = false
  for (const [index, item] of content.entries()) {
    const text = typeof item === 'string' ? item : asRecord(item)?.text
    if (typeof text === 'string' && text) {
      parts.push(text)
      length += text.length
      if (length >= TRANSCRIPT_MESSAGE_TEXT_LIMIT) {
        omitted = index + 1 < content.length
        break
      }
    }
  }
  const joined = boundedJoinedText(parts)
  return { ...joined, textTruncated: omitted || joined.textTruncated }
}

/**
 * Splits one provider content value into the messages it decodes to. Text
 * blocks keep the record's role; tool_use and tool_result blocks become `tool`
 * messages whichever record carried them (Claude stores tool results on user
 * records), so a consumer never has to know a provider's record shapes.
 */
export function transcriptMessagesFromContent(
  role: PreviewRole,
  content: unknown,
  timestamp: string | null
): TranscriptMessage[] {
  const messages: TranscriptMessage[] = []
  const textRole = transcriptMessageRole(role)
  if (typeof content === 'string') {
    const message = textRole ? transcriptMessageFromText(textRole, content, timestamp) : null
    return message ? [message] : []
  }
  const blocks = Array.isArray(content) ? content : content != null ? [content] : []
  const textParts: string[] = []
  for (const block of blocks) {
    if (typeof block === 'string') {
      textParts.push(block)
      continue
    }
    const item = asRecord(block)
    if (!item) {
      continue
    }
    // Codex 0.153+ item_completed blocks are typed `Text`; the set is lowercase.
    const type = typeof item.type === 'string' ? item.type.toLowerCase() : null
    if (type === 'tool_use') {
      pushMessage(messages, 'tool', toolCallContent(item.name, item.input), timestamp)
      continue
    }
    if (type === 'tool_result') {
      pushMessage(messages, 'tool', toolResultText(item.content), timestamp)
      continue
    }
    if (type !== null && !TEXT_BLOCK_TYPES.has(type)) {
      continue
    }
    const text = typeof item.text === 'string' ? item.text : item.content
    if (typeof text === 'string' && text) {
      textParts.push(text)
    }
  }
  if (textRole && textParts.length > 0) {
    // The record's own words lead; its tool blocks follow in transcript order.
    const content = boundedJoinedText(textParts)
    const message = content.text
      ? transcriptMessageFromText(textRole, content.text, timestamp, content.textTruncated)
      : null
    if (message) {
      messages.unshift(message)
    }
  }
  return messages
}

function boundedJoinedText(parts: readonly string[]): TranscriptText {
  const length =
    parts.reduce((total, part) => total + part.length, 0) + Math.max(0, parts.length - 1)
  if (parts.length === 1) {
    const text = boundedText(parts[0])
    return { text, textTruncated: text !== null && text.length < length }
  }
  const prefixes: string[] = []
  // One extra code unit preserves truncation at a trailing high surrogate.
  let remaining = TRANSCRIPT_MESSAGE_TEXT_LIMIT + 1
  for (const part of parts) {
    if (prefixes.length > 0) {
      remaining--
    }
    const prefix = part.slice(0, remaining)
    prefixes.push(prefix)
    remaining -= prefix.length
    if (remaining === 0) {
      break
    }
  }
  const text = boundedText(prefixes.join('\n'))
  return { text, textTruncated: text !== null && text.length < length }
}

function pushMessage(
  messages: TranscriptMessage[],
  role: TranscriptMessageRole,
  content: TranscriptText,
  timestamp: string | null
): void {
  const message =
    content.text === null
      ? null
      : transcriptMessageFromText(role, content.text, timestamp, content.textTruncated)
  if (message) {
    messages.push(message)
  }
}

export function transcriptMessageFromText(
  role: TranscriptMessageRole,
  value: string,
  timestamp: string | null,
  textTruncated = false
): TranscriptMessage | null {
  const text = boundedText(value)
  return text
    ? {
        role,
        text,
        timestamp,
        ...(textTruncated || text.length < value.length ? { textTruncated: true as const } : {})
      }
    : null
}

export function boundedText(value: string): string | null {
  const bounded = sliceAtCodeUnitLimit(value, TRANSCRIPT_MESSAGE_TEXT_LIMIT)
  return bounded.trim() ? bounded : null
}
