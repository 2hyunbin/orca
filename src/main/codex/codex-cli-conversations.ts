import { readSelectedSessionInBackground } from '../ai-vault/selected-session-reader-client'
import { isLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { findSelectedTranscriptPath } from '../native-chat/selected-transcript-path'
import { join } from 'node:path'
import { configuredAdditionalCodexHomePaths } from '../ai-vault/cached-session-list'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import {
  directoryTranscriptImport,
  resumeInvocationAfterMarker,
  type StructuredAgentCliConversations,
  type StructuredAgentSessionHistory
} from '../native-chat/structured-agent-cli-conversations'
import { resolveOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'

const CODEX_TRANSCRIPT_IMPORT = directoryTranscriptImport({
  transcriptRoot: ({ accountHomePath }) => join(accountHomePath, 'sessions'),
  readSelectedSession: ({ transcriptPath, accountHome, signal }) =>
    readSelectedSessionInBackground(
      {
        agent: 'codex',
        filePath: transcriptPath,
        codexHome: isLegacyAgentSessionAccountHome(accountHome) ? accountHome.path : null
      },
      signal
    ),
  accountHomeCandidates: ({ settings, selectedAccountHomePath }) => [
    selectedAccountHomePath,
    ...(settings.codexManagedAccounts ?? []).map((account) => account.managedHomePath),
    ...configuredAdditionalCodexHomePaths(),
    resolveOrcaManagedCodexHomePath(),
    getSystemCodexHomePath()
  ],
  findTranscript: ({ providerSessionId, accountHomePath, selected }) =>
    selected
      ? findSelectedTranscriptPath('codex', providerSessionId, accountHomePath, selected)
      : resolveSessionFilePath('codex', providerSessionId, {
          codexSessionsDirs: [join(accountHomePath, 'sessions')]
        })
})

const CODEX_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['codex'],
  rowSessionId: (link) => link.handle.nativeId,
  // `codex fork` carries no `resume` marker, and Codex has no target-less resume flag.
  parseResumeArgs: (args) => resumeInvocationAfterMarker(args, ['resume'])
}

export const CODEX_CLI_CONVERSATIONS: StructuredAgentCliConversations = {
  transcriptImport: CODEX_TRANSCRIPT_IMPORT,
  sessionHistory: CODEX_SESSION_HISTORY
}
