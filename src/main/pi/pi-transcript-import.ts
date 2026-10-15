import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { throwIfSignalAborted } from '../../shared/abort-signal-reason'
import { isLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { isWslUncPath } from '../../shared/wsl-paths'
import { readSelectedSessionInBackground } from '../ai-vault/selected-session-reader-client'
import { sessionIdFromFileName } from '../ai-vault/session-scanner-accumulator'
import { walkSessionFiles } from '../ai-vault/session-scanner-discovery'
import { piSessionHistorySessionsDir } from '../ai-vault/session-scanner-agent-sources'
import { normalizeExistingPath } from '../ipc/filesystem-path-containment'
import type { StructuredAgentTranscriptImport } from '../native-chat/structured-agent-cli-conversations'
import { findSelectedTranscriptFile } from '../native-chat/selected-transcript-path'
import { admitTranscriptPath } from '../native-chat/transcript-path-admission'
import { readPiSessionHeader } from './rpc-launch-resolution'

export const PI_TRANSCRIPT_IMPORT: StructuredAgentTranscriptImport = {
  readSelectedSession: ({ transcriptPath, signal }) =>
    readSelectedSessionInBackground(
      { agent: 'pi', filePath: transcriptPath, codexHome: null },
      signal
    ),
  admitTranscriptPath: async ({ transcriptPath }) =>
    (await admitTranscriptPath(piSessionHistorySessionsDir(), transcriptPath))?.path ?? null,
  // Session History's host source is authoritative, including when the chat chose another home.
  accountHomeCandidates: () => [
    {
      variable: 'PI_CODING_AGENT_DIR',
      path: process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent')
    }
  ],
  // The file Session History lists under this id.
  findTranscript: async ({ providerSessionId, accountHome, selected }) => {
    if (!isLegacyAgentSessionAccountHome(accountHome)) {
      return null
    }
    const root = piSessionHistorySessionsDir()
    if (selected && isWslUncPath(root)) {
      throw new Error('This conversation cannot be resumed on this host.')
    }
    const exact = selected ? await findSelectedTranscriptFile(root, selected) : null
    const files = await walkSessionFiles(root, 'pi', [], {
      extensions: new Set(['.jsonl']),
      filePredicate: (path) => sessionIdFromFileName(path) === providerSessionId,
      ...(selected ? { signal: selected.signal, strictReadErrors: true } : {})
    })
    if (files.length !== 1) {
      return null
    }
    const file = files[0]
    if (!file) {
      return null
    }
    if (exact) {
      const [canonicalExact, canonicalFile] = await Promise.all([
        normalizeExistingPath(exact),
        normalizeExistingPath(file)
      ])
      if (
        sessionIdFromFileName(exact) !== providerSessionId ||
        relative(canonicalExact, canonicalFile) !== ''
      ) {
        return null
      }
    }
    const header = await readPiSessionHeader(file)
    throwIfSignalAborted(selected?.signal)
    if (header?.id !== providerSessionId) {
      return null
    }
    return file
  },
  // A Pi chat's handle names its session file, not the id.
  handleNamesTranscript: true
}
