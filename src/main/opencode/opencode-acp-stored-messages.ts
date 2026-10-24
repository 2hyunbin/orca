import { homedir } from 'node:os'
import { OPENCODE_TRANSCRIPT_MAX_WINDOW } from '../../shared/opencode-transcript-page-limit'
import type { AcpStoredUserMessagesReader } from '../acp/acp-recovery-history'
import { resolveOpenCodeDatabasePath } from './opencode-data-directory'
import type { readOpenCodeTranscriptPageViaWorker } from '../ai-vault/session-scanner-opencode-sqlite-worker-spawn'

export type OpenCodeTranscriptPageReader = typeof readOpenCodeTranscriptPageViaWorker

/** Read the pinned account’s stored user messages through the bounded reader, preferring v2. */
export function openCodeStoredUserMessagesReader(
  readPage?: OpenCodeTranscriptPageReader
): AcpStoredUserMessagesReader {
  return async ({ env, providerSessionId, signal }) => {
    // Use the child account’s home rather than this process’s.
    const home = (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir()
    const dbPath = resolveOpenCodeDatabasePath(env, home)
    if (!dbPath) {
      return null
    }
    const read =
      readPage ??
      (await import('../ai-vault/session-scanner-opencode-sqlite-worker-spawn'))
        .readOpenCodeTranscriptPageViaWorker
    const page = await read(
      { dbPath, sessionId: providerSessionId, limit: OPENCODE_TRANSCRIPT_MAX_WINDOW },
      signal
    )
    if (!page) {
      return null
    }
    return page.items.flatMap(({ message }) =>
      message.role === 'user' && message.timestamp !== null
        ? [{ id: message.id, blocks: message.blocks, createdAt: message.timestamp }]
        : []
    )
  }
}
