import { join } from 'node:path'
import { isLegacyAgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import { resolveSessionFilePath } from '../session-file-resolver'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import type { AgentProviderSessionMetadata } from '../../../shared/agent-session-resume'
import type {
  AgentSessionHistoryRequest,
  AgentSessionHistoryResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  readAgentSessionHistory,
  type AgentSessionHistoryScope
} from './agent-session-history-page'
import {
  withPublishedWorkResult,
  type AgentSessionPublishedWork
} from './agent-session-published-work'

export function structuredAgentSessionProviderSessionMetadata(
  record: AgentSessionRecord | null
): AgentProviderSessionMetadata | undefined {
  const head = record ? agentSessionProviderHandleChainHead(record.providerHandleChain) : null
  return head ? { key: 'session_id', id: head.handle.nativeId } : undefined
}

export function readStructuredAgentSessionHistoryResult(input: {
  journal: AgentSessionJournal
  record: AgentSessionRecord | null
  request: AgentSessionHistoryRequest
  scope?: AgentSessionHistoryScope
  /** The host's current-work projection, which the page's turn and prompt fields state. */
  work?: AgentSessionPublishedWork
}): AgentSessionHistoryResult {
  const result = withPublishedWorkResult(
    readAgentSessionHistory(input.journal, input.request, { scope: input.scope }),
    input.work
  )
  const fence = input.record?.lease.runtimeFence
  const providerSession = structuredAgentSessionProviderSessionMetadata(input.record)
  if (fence === undefined) {
    return providerSession ? { ...result, providerSession } : result
  }
  return {
    ...result,
    page: { ...result.page, fence },
    ...(result.ok ? {} : { fence }),
    ...(providerSession ? { providerSession } : {})
  }
}

/** Resolve on the execution host, using the same account-scoped lookup as session history. */
export async function structuredAgentSessionTranscriptMetadata(
  record: AgentSessionRecord | null
): Promise<AgentProviderSessionMetadata | undefined> {
  const metadata = structuredAgentSessionProviderSessionMetadata(record)
  const head = record ? agentSessionProviderHandleChainHead(record.providerHandleChain) : null
  if (!record || !metadata || !head || !isLegacyAgentSessionAccountHome(record.accountHome)) {
    return metadata
  }
  const home = record.accountHome.path
  try {
    const transcriptPath = await resolveSessionFilePath(head.handle.agent, metadata.id, {
      ...(head.handle.agent === 'claude' ? { claudeProjectsDir: join(home, 'projects') } : {}),
      ...(head.handle.agent === 'codex' ? { codexSessionsDirs: [join(home, 'sessions')] } : {}),
      ...(head.handle.agent === 'grok' ? { grokSessionsDir: join(home, 'sessions') } : {}),
      ...(head.handle.agent === 'omp' ? { ompSessionsDir: join(home, 'sessions') } : {})
    })
    return transcriptPath ? { ...metadata, transcriptPath } : metadata
  } catch (error) {
    console.warn('[agent-session] transcript path lookup failed', error)
    return metadata
  }
}
