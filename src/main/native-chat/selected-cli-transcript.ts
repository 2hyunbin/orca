import { join } from 'node:path'
import { relativePathInsideRoot } from '../../shared/cross-platform-path'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { SelectedCliSessionSource } from '../../shared/ai-vault-selected-session'
import type { StructuredAgentTranscriptImportSettings } from './structured-agent-cli-conversations'
import { structuredAgentRuntimeRegistration } from '../runtime/structured-agent-runtime-registrations'
import { resolveStructuredAgentSessionAdoption } from './structured-agent-session-history-adoption'
import { throwIfSignalAborted } from '../../shared/abort-signal-reason'
import { isWslUncPath } from '../../shared/wsl-paths'

export function selectedCliSourceStatus(input: {
  agent: 'claude' | 'codex'
  providerSessionId: string
  source: SelectedCliSessionSource
  rows: readonly AgentStatusIpcPayload[]
}) {
  const row = input.rows.find(
    (candidate) =>
      candidate.paneKey === input.source.paneKey &&
      candidate.worktreeId === input.source.workspaceId &&
      candidate.agentType === input.agent &&
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

export async function resolveSelectedCliTranscript(input: {
  agent: 'claude' | 'codex'
  providerSessionId: string
  source: SelectedCliSessionSource
  rows: readonly AgentStatusIpcPayload[]
  selectedAccountHomePath: string
  settings: StructuredAgentTranscriptImportSettings
  cwd: string
  signal?: AbortSignal
}) {
  throwIfSignalAborted(input.signal)
  const row = selectedCliSourceStatus(input)
  const transcriptPath = row.providerSession?.transcriptPath
  return resolveSelectedAccountTranscript({ ...input, transcriptPath })
}

export async function resolveSelectedAccountTranscript(input: {
  agent: 'claude' | 'codex'
  providerSessionId: string
  selectedAccountHomePath: string
  settings: StructuredAgentTranscriptImportSettings
  cwd: string
  transcriptPath?: string
  signal?: AbortSignal
}) {
  const importer = structuredAgentRuntimeRegistration(input.agent)?.transcriptImport
  if (!importer) {
    throw new Error('Conversation import is unavailable.')
  }
  let homes = [...new Set(importer.accountHomeCandidates(input))]
  if (input.transcriptPath) {
    const attested = input.transcriptPath
    homes = homes.filter(
      (home) =>
        relativePathInsideRoot(
          join(home, input.agent === 'claude' ? 'projects' : 'sessions'),
          attested
        ) !== null
    )
    if (!homes.length) {
      throw new Error('The conversation account is not available on this host.')
    }
  }
  return resolveStructuredAgentSessionAdoption({
    providerSessionId: input.providerSessionId,
    candidateAccountHomes: homes,
    resolveTranscript: (args) => {
      throwIfSignalAborted(input.signal)
      return importer.findTranscript({
        ...args,
        selected: {
          cwd: input.cwd,
          transcriptPath: input.transcriptPath,
          signal: input.signal
        }
      })
    }
  })
}
