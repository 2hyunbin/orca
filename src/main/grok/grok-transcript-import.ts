import { readSelectedSessionInBackground } from '../ai-vault/selected-session-reader-client'
import { isLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { join } from 'node:path'
import { findGrokChatHistoryByCwd, resolveGrokHomeDir } from '../../shared/grok-session-paths'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { directoryTranscriptImport } from '../native-chat/structured-agent-cli-conversations'

export const GROK_TRANSCRIPT_IMPORT = directoryTranscriptImport({
  transcriptRoot: ({ accountHomePath }) => join(accountHomePath, 'sessions'),
  readSelectedSession: ({ transcriptPath, providerSessionId, accountHome, signal }) => {
    if (!isLegacyAgentSessionAccountHome(accountHome)) {
      throw new Error('Conversation account is unavailable.')
    }
    return readSelectedSessionInBackground(
      {
        agent: 'grok',
        filePath: transcriptPath,
        providerSessionId,
        accountHomePath: accountHome.path,
        codexHome: null
      },
      signal
    )
  },
  // The chat's own home, then the one Session History lists Grok's conversations from.
  accountHomeCandidates: ({ selectedAccountHomePath }) => [
    selectedAccountHomePath,
    resolveGrokHomeDir()
  ],
  findTranscript: async ({ providerSessionId, accountHomePath, workspaceCwd, selected }) => {
    const sessionsDir = join(accountHomePath, 'sessions')
    selected?.signal?.throwIfAborted()
    return waitForPromiseWithSignal(
      (async () =>
        (await findGrokChatHistoryByCwd({
          sessionId: providerSessionId,
          cwd: workspaceCwd,
          sessionsDir
        })) ??
        resolveSessionFilePath(
          'grok',
          providerSessionId,
          { grokSessionsDir: sessionsDir },
          selected?.signal
        ))(),
      selected?.signal
    )
  }
})
