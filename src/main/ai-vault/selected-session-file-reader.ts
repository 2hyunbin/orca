import { stat } from 'node:fs/promises'
import { parseAgentSessionFile } from './session-scanner-agent-parser'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { SELECTED_TRANSCRIPT_MAX_BYTES } from '../../shared/ai-vault-selected-session'
import { throwIfSignalAborted } from '../../shared/abort-signal-reason'

export type SelectedSessionFileRequest = {
  agent: 'claude' | 'codex'
  filePath: string
  codexHome: string | null
}

export async function readSelectedSessionFile(
  request: SelectedSessionFileRequest,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  throwIfSignalAborted(signal)
  const info = await stat(request.filePath)
  if (!info.isFile()) {
    throw new Error('Conversation history is not a regular file.')
  }
  if (info.size > SELECTED_TRANSCRIPT_MAX_BYTES) {
    throw new Error('Conversation history exceeds the import size limit.')
  }
  if (info.size === 0) {
    return null
  }
  const session = await parseAgentSessionFile(
    {
      agent: request.agent,
      file: {
        path: request.filePath,
        mtimeMs: info.mtimeMs,
        modifiedAt: info.mtime.toISOString(),
        sizeBytes: info.size
      },
      codexHome: request.codexHome
    },
    process.platform,
    undefined,
    signal,
    { signal }
  )
  throwIfSignalAborted(signal)
  if (!session) {
    throw new Error('Conversation history could not be read.')
  }
  return session
}
