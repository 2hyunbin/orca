import { wslGatedReaddir, wslGatedReadFile } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { join } from 'node:path'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { FileWithMtime, SessionAccumulator } from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  addPreviewMessage,
  createAccumulator,
  finalizeSession,
  seedFullFirstUserPrompt,
  sessionIdFromFileName,
  updateTimeline
} from './session-scanner-accumulator'
import { extractFullFirstUserPromptText } from './session-scanner-first-user-prompt'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import {
  asRecord,
  extractPreviewContentText,
  extractString,
  findOpenCodeStorageRoot,
  normalizeTitleText,
  timeObjectValue,
  timestampMs,
  tokenTotal
} from './session-scanner-values'

export async function parseOpenCodeSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  const parsed: unknown = JSON.parse(await wslGatedReadFile(file.path, 'utf-8', 'scan', signal))
  const record = asRecord(parsed)
  if (!record) {
    return null
  }
  const sessionId = extractString(record.id) ?? sessionIdFromFileName(file.path)
  const accumulator = createAccumulator({ agent: 'opencode', file, sessionId, messages })
  accumulator.title = normalizeTitleText(extractString(record.title) ?? '')
  accumulator.cwd = extractString(record.directory)
  updateTimeline(accumulator, timeObjectValue(record.time, 'created'))
  updateTimeline(accumulator, timeObjectValue(record.time, 'updated'))
  await consumeOpenCodeMessages(accumulator, findOpenCodeStorageRoot(file.path), sessionId, signal)
  return finalizeSession(accumulator, platform)
}

// Why: OpenCode stores one file per message and `readdir` order is arbitrary,
// so the transcript has to be rebuilt by creation time before anything reads
// "the first user prompt". Undated messages sort last, by file name, so a
// missing timestamp can never displace a real first turn.
async function readOpenCodeMessagesInOrder(
  messageDir: string,
  signal: AbortSignal | undefined
): Promise<Record<string, unknown>[]> {
  let entries
  try {
    entries = await wslGatedReaddir(messageDir, 'scan', signal)
  } catch (error) {
    // A session with no message dir yet is empty; a gate refusal is not — an
    // empty transcript would otherwise be cached under the session's mtime.
    if (error instanceof WslTranscriptFsError) {
      throw error
    }
    return []
  }
  const messages: { name: string; createdMs: number; message: Record<string, unknown> }[] = []
  for (const entry of entries) {
    throwIfAiVaultScanCancelled(signal)
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue
    }
    let message: Record<string, unknown> | null = null
    try {
      const parsed: unknown = JSON.parse(
        await wslGatedReadFile(join(messageDir, entry.name), 'utf-8', 'scan', signal)
      )
      message = asRecord(parsed)
    } catch (error) {
      // A live OpenCode process can leave a half-written file; skip it rather
      // than discard the whole session. A refused read is not a bad file — the
      // partial transcript it would produce must not become the cached answer.
      if (error instanceof WslTranscriptFsError) {
        throw error
      }
      continue
    }
    if (!message) {
      continue
    }
    const createdMs = timestampMs(timeObjectValue(message.time, 'created'))
    messages.push({
      name: entry.name,
      createdMs: Number.isFinite(createdMs) ? createdMs : Number.POSITIVE_INFINITY,
      message
    })
  }
  return messages
    .sort((a, b) => a.createdMs - b.createdMs || a.name.localeCompare(b.name))
    .map((entry) => entry.message)
}

export async function consumeOpenCodeMessages(
  accumulator: SessionAccumulator,
  storageRoot: string | null,
  sessionId: string,
  signal?: AbortSignal
): Promise<void> {
  if (!storageRoot) {
    return
  }
  for (const message of await readOpenCodeMessagesInOrder(
    join(storageRoot, 'message', sessionId),
    signal
  )) {
    const role = extractString(message.role)
    if (role === 'user' || role === 'assistant') {
      accumulator.messageCount++
      updateTimeline(accumulator, timeObjectValue(message.time, 'created'))
      const summary = asRecord(message.summary)
      if (role === 'user') {
        accumulator.title ??= extractString(summary?.title) ?? extractString(summary?.body)
      }
      // Why: the summary fallbacks are AI-generated. Seed the copyable first
      // prompt from real typed content only, never from a summary of a
      // harness-injected turn. Extraction stays inside the thunk so list scans
      // (capture mode `none`) never pay for it.
      seedFullFirstUserPrompt(accumulator, role, () =>
        extractFullFirstUserPromptText(message.content)
      )
      addPreviewMessage(accumulator, {
        role,
        text:
          extractPreviewContentText(message.content) ??
          extractString(summary?.body) ??
          extractString(summary?.title),
        timestamp: timeObjectValue(message.time, 'created'),
        seedFirstUserPrompt: false
      })
      accumulator.model =
        extractString(asRecord(message.model)?.modelID) ||
        extractString(message.modelID) ||
        accumulator.model
      accumulator.totalTokens += tokenTotal(message.tokens)
    }
  }
}
