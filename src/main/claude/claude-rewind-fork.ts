import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import type { AgentSessionProviderHandle } from '../../shared/agent-session-provider-handle'
import type { AgentSessionRewindFork } from '../../shared/agent-session-rewind'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { splitTranscriptStreamLines } from '../native-chat/transcript-stream-lines'
import { claudeSessionIdForRewind } from './claude-structured-session-id'

type TranscriptPromptRow = { type: 'user'; uuid: string; parentUuid?: unknown }

function isPromptRow(value: unknown, promptUuid: string): value is TranscriptPromptRow {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'user' &&
    'uuid' in value &&
    value.uuid === promptUuid
  )
}

/**
 * Where a rewind to this prompt cuts: the prompt's parent, the last entry of the turn kept before
 * it, which is where Claude's truncating resume must fork. Null when the prompt opened the
 * conversation; undefined when the transcript holds no such prompt.
 */
export async function readClaudePromptParentUuid(input: {
  providerSessionId: string
  promptUuid: string
  claudeConfigDir: string
}): Promise<string | null | undefined> {
  const path = await resolveSessionFilePath('claude', input.providerSessionId, {
    claudeProjectsDir: join(input.claudeConfigDir, 'projects')
  })
  if (!path) {
    return undefined
  }
  for await (const { line } of splitTranscriptStreamLines(createReadStream(path))) {
    if (!line.includes(input.promptUuid)) {
      continue
    }
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (isPromptRow(row, input.promptUuid)) {
      return typeof row.parentUuid === 'string' && row.parentUuid ? row.parentUuid : null
    }
  }
  return undefined
}

/**
 * The fork that rewinds a chat to before `prompt`: a new session holding the conversation up to the
 * prompt's parent, read from the prompt's own session so a rewind past an earlier rewind still finds
 * it. Null when no searched home holds that prompt.
 */
export async function resolveClaudeRewindFork(input: {
  orcaSessionId: string
  rewindOperationId: string
  head: AgentSessionProviderHandle
  prompt: { sessionId: string; uuid: string }
  claudeConfigDirs: readonly string[]
}): Promise<AgentSessionRewindFork | null> {
  for (const claudeConfigDir of new Set(input.claudeConfigDirs)) {
    const parent = await readClaudePromptParentUuid({
      providerSessionId: input.prompt.sessionId,
      promptUuid: input.prompt.uuid,
      claudeConfigDir
    })
    if (parent !== undefined) {
      return {
        sessionId: claudeSessionIdForRewind(input.orcaSessionId, input.rewindOperationId),
        sourceSessionId: input.prompt.sessionId,
        ...(parent ? { throughEntryId: parent } : {}),
        replacesSessionId: input.head.nativeId
      }
    }
  }
  return null
}
