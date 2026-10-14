import { wslGatedReadFile } from '../native-chat/wsl-transcript-fs-access'
import { basename, dirname, join } from 'node:path'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { FileWithMtime, SessionAccumulator } from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  addPreviewContent,
  addPreviewMessage,
  createAccumulator,
  finalizeSession,
  updateTimeline
} from './session-scanner-accumulator'
import {
  arrayValue,
  asRecord,
  extractContentText,
  extractString,
  firstString,
  readJsonObjectIfExists
} from './session-scanner-values'
export {
  parseMessageGraphSessionFile,
  parseMessageGraphSessionContent,
  createMessageGraphSessionResumeState,
  type MessageGraphAgent
} from './session-scanner-message-graph-parser'

export async function parseRovoSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  const metadata = asRecord(
    JSON.parse(await wslGatedReadFile(file.path, 'utf-8', 'scan')) as unknown
  )
  if (!metadata) {
    return null
  }
  const accumulator = createAccumulator({
    agent: 'rovo',
    file,
    sessionId: basename(dirname(file.path)),
    messages
  })
  accumulator.title = firstString(metadata, ['title', 'name', 'summary'])
  accumulator.cwd = firstString(metadata, [
    'workspace_path',
    'workspacePath',
    'workspace',
    'cwd',
    'working_directory',
    'workingDirectory',
    'project_path',
    'projectPath'
  ])
  updateTimeline(
    accumulator,
    extractString(metadata.created_at) ?? extractString(metadata.createdAt)
  )
  updateTimeline(
    accumulator,
    extractString(metadata.updated_at) ?? extractString(metadata.updatedAt)
  )

  const contextPath = join(dirname(file.path), 'session_context.json')
  const context = await readJsonObjectIfExists(contextPath)
  if (context) {
    consumeRovoSessionContext(accumulator, context)
  }

  return finalizeSession(accumulator, platform)
}

export function consumeRovoSessionContext(
  accumulator: SessionAccumulator,
  context: Record<string, unknown>
): void {
  for (const message of arrayValue(context.messages)) {
    const record = asRecord(message)
    const role = extractString(record?.role)
    if (role === 'user' || role === 'assistant') {
      accumulator.messageCount++
      updateTimeline(accumulator, extractString(record?.timestamp))
      if (role === 'user') {
        accumulator.title ??= extractContentText(record?.content)
      }
      addPreviewContent(accumulator, role, record?.content, record?.timestamp)
    }
  }

  for (const historyEntry of arrayValue(context.message_history)) {
    consumeRovoHistoryEntry(accumulator, asRecord(historyEntry))
  }
}

export function consumeRovoHistoryEntry(
  accumulator: SessionAccumulator,
  record: Record<string, unknown> | null
): void {
  if (!record) {
    return
  }
  updateTimeline(accumulator, extractString(record.timestamp))
  const role = extractString(record.role) ?? rovoRoleFromKind(record.kind)
  if (role !== 'user' && role !== 'assistant') {
    return
  }
  const text = rovoPartsText(arrayValue(record.parts), role)
  if (!text) {
    return
  }
  accumulator.messageCount++
  if (role === 'user') {
    accumulator.title ??= text
  }
  addPreviewMessage(accumulator, {
    role,
    text,
    timestamp: record.timestamp
  })
}

export function rovoRoleFromKind(value: unknown): 'user' | 'assistant' | null {
  if (value === 'request') {
    return 'user'
  }
  if (value === 'response') {
    return 'assistant'
  }
  return null
}

export function rovoPartsText(parts: unknown[], role: 'user' | 'assistant'): string | null {
  const textParts: string[] = []
  for (const part of parts) {
    const record = asRecord(part)
    if (!record) {
      continue
    }
    const kind = extractString(record.part_kind)
    if (role === 'user' && kind !== 'user-prompt' && kind !== 'text') {
      continue
    }
    if (role === 'assistant' && kind !== 'text') {
      continue
    }
    const text =
      typeof record.content === 'string'
        ? record.content
        : typeof record.text === 'string'
          ? record.text
          : null
    if (text !== null) {
      textParts.push(text)
    }
  }
  return extractContentText(textParts)
}
