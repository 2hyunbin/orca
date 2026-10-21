import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { StructuredAgentTranscriptSource } from '../native-chat/structured-agent-cli-conversations'
import { assertAdoptedSourceIdentity } from '../native-chat/agent-session-journal/adopted-transcript-source'
import { readOpenCodeTranscriptSignalViaWorker } from '../ai-vault/session-scanner-opencode-sqlite-worker-spawn'
import { readOpenCodeNativeChatTranscriptFull } from '../native-chat/transcript-opencode'
import { OPENCODE_CAPTURE_TEXT_LIMIT } from '../ai-vault/opencode-transcript-capture-limits'
import { renameFileWithWindowsRetryAsync } from '../../shared/windows-retry-file-operations'

export async function openCodeContextVersion(source: StructuredAgentTranscriptSource) {
  const signal = await readOpenCodeTranscriptSignalViaWorker({
    dbPath: source.transcriptPath,
    sessionId: source.providerSessionId
  })
  if (!signal) {
    return null
  }
  assertAdoptedSourceIdentity(source, {
    sessionId: source.providerSessionId,
    cwd: signal.cwd ?? null
  })
  return JSON.stringify(signal)
}

/** The database is a locator; only its identified, completely decoded conversation is portable. */
export async function prepareOpenCodeReadableContext(
  source: StructuredAgentTranscriptSource,
  path: string
): Promise<string | null> {
  const version = await openCodeContextVersion(source)
  if (!version) {
    return null
  }
  const read = await readOpenCodeNativeChatTranscriptFull(
    source.providerSessionId,
    { resolveDbPath: async () => source.transcriptPath },
    undefined,
    undefined,
    { requireComplete: true }
  )
  if ('error' in read || version !== (await openCodeContextVersion(source))) {
    return null
  }
  const text = JSON.stringify({
    source,
    providerSessionId: source.providerSessionId,
    workspaceCwd: source.workspaceCwd,
    messages: read.messages
  })
  if (Buffer.byteLength(text) > OPENCODE_CAPTURE_TEXT_LIMIT) {
    return null
  }
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
    await renameFileWithWindowsRetryAsync(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch((error: unknown) => {
      console.warn('Could not remove hand-off context temporary file', error)
    })
  }
  return path
}
