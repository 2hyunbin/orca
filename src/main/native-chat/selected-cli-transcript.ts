import type { AgentSessionAccountHome } from '../../shared/agent-session-account-home'
import {
  adoptsCliConversations,
  CLI_CONVERSATION_ADOPTING_AGENTS,
  type CliConversationAdoptingAgent
} from '../../shared/structured-agent-cli-conversation-adoption'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { SelectedCliSessionSource } from '../../shared/ai-vault-selected-session'
import type { StructuredAgentTranscriptImportSettings } from './structured-agent-cli-conversations'
import { structuredAgentRuntimeRegistration } from '../runtime/structured-agent-runtime-registrations'
import { resolveStructuredAgentSessionAdoption } from './structured-agent-session-history-adoption'
import { throwIfSignalAborted } from '../../shared/abort-signal-reason'
import { isWslUncPath } from '../../shared/wsl-paths'

export function selectedCliSourceStatus(input: {
  agent: CliConversationAdoptingAgent
  providerSessionId: string
  source: SelectedCliSessionSource
  rows: readonly AgentStatusIpcPayload[]
}) {
  const row = input.rows.find(
    (candidate) =>
      candidate.paneKey === input.source.paneKey &&
      candidate.worktreeId === input.source.workspaceId &&
      adoptsCliConversations(candidate.agentType) &&
      CLI_CONVERSATION_ADOPTING_AGENTS[candidate.agentType] === input.agent &&
      candidate.providerSession?.id === input.providerSessionId &&
      !candidate.connectionId &&
      !candidate.structuredHost
  )
  if (!row) {
    throw new Error('The source conversation is no longer available.')
  }
  if (row.providerSession?.transcriptPath && isWslUncPath(row.providerSession.transcriptPath)) {
    throw new Error('This conversation cannot be resumed on this host.')
  }
  return row
}

type SelectedAccountTranscriptInput = {
  agent: CliConversationAdoptingAgent
  providerSessionId: string
  selectedAccountHome: AgentSessionAccountHome
  settings: StructuredAgentTranscriptImportSettings
  launchEnv: NodeJS.ProcessEnv
  workspaceCwd: string
  transcriptPath?: string
  signal?: AbortSignal
}

export async function resolveSelectedCliTranscript(
  input: SelectedAccountTranscriptInput & {
    source: SelectedCliSessionSource
    rows: readonly AgentStatusIpcPayload[]
  }
) {
  throwIfSignalAborted(input.signal)
  const row = selectedCliSourceStatus(input)
  return resolveSelectedAccountTranscript({
    ...input,
    transcriptPath: row.providerSession?.transcriptPath
  })
}

export async function resolveSelectedAccountTranscript(input: SelectedAccountTranscriptInput) {
  const importer = structuredAgentRuntimeRegistration(input.agent)?.transcriptImport
  if (!importer) {
    throw new Error('Conversation import is unavailable.')
  }
  let homes = importer.accountHomeCandidates(input)
  if (input.transcriptPath && importer.admitTranscriptPath) {
    const attested = input.transcriptPath
    const admitted = await Promise.all(
      homes.map(async (accountHome) => ({
        accountHome,
        path: await importer.admitTranscriptPath?.({
          ...input,
          accountHome,
          transcriptPath: attested
        })
      }))
    )
    throwIfSignalAborted(input.signal)
    homes = admitted
      .filter((candidate) => candidate.path != null)
      .map((candidate) => candidate.accountHome)
    if (!homes.length) {
      throw new Error('The conversation account is not available on this host.')
    }
  }
  return resolveStructuredAgentSessionAdoption({
    ...input,
    candidateAccountHomes: homes,
    resolveTranscript: (args) => {
      throwIfSignalAborted(input.signal)
      return importer.findTranscript({
        ...args,
        selected: {
          cwd: input.workspaceCwd,
          transcriptPath: input.transcriptPath,
          signal: input.signal
        }
      })
    }
  })
}
