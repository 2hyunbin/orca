import { prepareSelectedCodexAdoption } from '../native-chat/selected-codex-adoption-preparation'
import type { AiVaultSessionResumePreparation } from '../../shared/ai-vault-resume-preparation'
import type { SelectedCliSessionSource } from '../../shared/ai-vault-selected-session'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { resolveSelectedCliTranscript } from '../native-chat/selected-cli-transcript'
import { withSelectedSessionDeadline } from '../ai-vault/selected-session-deadline'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'
import { agentSessionExecutionLocationsEqual } from '../../shared/agent-session-record'
import type { AgentSessionAttachParams } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { listStructuredProviderSessionOwnership } from '../native-chat/agent-session-wire/structured-provider-session-ownership'
import {
  findCommittedStructuredAgentSessionAdoptionReplay,
  findConflictingStructuredAdoption,
  resolveStructuredAgentSessionAdoption,
  structuredAdoptionConflictError
} from '../native-chat/structured-agent-session-history-adoption'
import type {
  StructuredAgentTranscriptImport,
  StructuredAgentTranscriptImportSettings
} from '../native-chat/structured-agent-cli-conversations'

export function resolveCommittedStructuredAgentSessionAdoptionIntent(input: {
  host: StructuredAgentSessionHost | null
  envelope: { sessionId: string; clientOperationId: string }
  agent: StructuredAgentId
  callerKey?: string
  resumeFrom?: { providerSessionId: string }
  location: AgentSessionExecutionLocation
  options?: Readonly<Record<string, string>>
}): AgentSessionAttachParams | null {
  const replay =
    input.resumeFrom && input.callerKey && input.host
      ? findCommittedStructuredAgentSessionAdoptionReplay({
          agent: input.agent,
          providerSessionId: input.resumeFrom.providerSessionId,
          selfSessionId: input.envelope.sessionId,
          callerKey: input.callerKey,
          operationId: input.envelope.clientOperationId,
          record: input.host.deps.store.getRecord(input.envelope.sessionId),
          operations: input.host.deps.store.listOperationRows()
        })
      : null
  if (!replay || !agentSessionExecutionLocationsEqual(replay.record.location, input.location)) {
    return null
  }
  return {
    envelope: {
      sessionId: input.envelope.sessionId,
      clientOperationId: input.envelope.clientOperationId,
      expectedRuntimeFence: null,
      payloadFingerprint: ''
    },
    location: input.location,
    provider: input.agent,
    agent: input.agent,
    accountHome: replay.record.accountHome,
    ...(input.options ? { options: input.options } : {}),
    adopt: { providerHandle: replay.providerHandle },
    runtimeKind: 'native'
  }
}

export async function resolveStructuredAgentSessionAdoptionForCreate(input: {
  host: StructuredAgentSessionHost | null
  settings: StructuredAgentTranscriptImportSettings
  agent: StructuredAgentId
  /** The agent's registered importer; only an agent with one adopts. */
  transcriptImport: StructuredAgentTranscriptImport
  providerSessionId: string
  selfSessionId: string
  selectedAccountHomePath: string
  selectedSource?: SelectedCliSessionSource
  sourceRows?: readonly AgentStatusIpcPayload[]
  sourceCwd?: string | null
  prepareSessionResume?: AiVaultSessionResumePreparation
}) {
  const conflict = input.host
    ? findConflictingStructuredAdoption({
        agent: input.agent,
        providerSessionId: input.providerSessionId,
        selfSessionId: input.selfSessionId,
        ownership: listStructuredProviderSessionOwnership(input.host.deps.store.listRecords())
      })
    : null
  if (conflict) {
    throw structuredAdoptionConflictError(conflict)
  }
  const source = input.selectedSource
  if (source) {
    const agent = input.agent
    if ((agent !== 'claude' && agent !== 'codex') || !input.sourceCwd) {
      throw new Error('The source conversation is unavailable on this host.')
    }
    return withSelectedSessionDeadline(async (signal) => {
      const resolved = await resolveSelectedCliTranscript({
        agent,
        providerSessionId: input.providerSessionId,
        source,
        rows: input.sourceRows ?? [],
        cwd: input.sourceCwd ?? '',
        selectedAccountHomePath: input.selectedAccountHomePath,
        settings: input.settings,
        signal
      })
      return agent === 'codex'
        ? prepareSelectedCodexAdoption(
            resolved,
            input.providerSessionId,
            input.prepareSessionResume,
            signal
          )
        : resolved
    })
  }
  return resolveStructuredAgentSessionAdoption({
    providerSessionId: input.providerSessionId,
    candidateAccountHomes: input.transcriptImport.accountHomeCandidates(input),
    resolveTranscript: input.transcriptImport.findTranscript
  })
}
