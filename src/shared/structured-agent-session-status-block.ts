import { readWholeAgentSessionFailureFact } from './agent-session-failure'
import type { AgentJournalStatusItem, AgentJournalTurnScope } from './agent-session-journal-types'
import { parseAgentJournalItemKey } from './agent-session-journal-item-key'
import { agentSessionOrcaStopRowBody, readAgentSessionOrcaStopRow } from './agent-session-orca-stop'
import { STALE_SESSION_ROW_PREFIX } from './agent-session-stop-row-identity'
import type { NativeChatTextBlock } from './native-chat-types'
import {
  AGENT_SESSION_COMPACTION_SKIPPED_PRESENTATION,
  isAgentSessionLegacyCompactionResult
} from './agent-session-compaction'

/** An older host's red row about an owner a reopen found gone, which named no cause and blamed the
 *  agent: stored with no presentation, under the prefix every such row has. */
function isOlderHostStaleSessionRow(body: AgentJournalStatusItem, itemId: string | undefined) {
  const identity = itemId === undefined ? null : parseAgentJournalItemKey(itemId)
  return (
    body.presentation === undefined &&
    identity?.provider === 'orca' &&
    identity.clientMessageId.startsWith(STALE_SESSION_ROW_PREFIX)
  )
}

/** A status row as the line a chat paints: named fields only, so a host-only key never leaks. */
export function structuredAgentSessionStatusBlock(
  stored: AgentJournalStatusItem,
  turnScope?: AgentJournalTurnScope,
  itemId?: string
): NativeChatTextBlock {
  // Painted as this build's row, but offering no Continue, which that host would refuse.
  const olderHostRow = isOlderHostStaleSessionRow(stored, itemId)
  const body = olderHostRow ? agentSessionOrcaStopRowBody(undefined) : stored
  const failure = readWholeAgentSessionFailureFact(body.failure)
  const orcaStop = olderHostRow ? null : readAgentSessionOrcaStopRow({ itemId: itemId ?? '', body })
  const presentation =
    body.presentation ??
    (body.tone === 'warning' && itemId !== undefined && isAgentSessionLegacyCompactionResult(itemId)
      ? AGENT_SESSION_COMPACTION_SKIPPED_PRESENTATION
      : undefined)
  return {
    type: 'text',
    text: body.text,
    ...(presentation !== undefined ? { presentation } : {}),
    ...(body.contextClear !== undefined ? { contextClear: body.contextClear } : {}),
    ...(body.tone !== undefined ? { tone: body.tone } : {}),
    ...(body.providerFrame ? { providerFrame: body.providerFrame } : {}),
    ...(failure ? { failure } : {}),
    ...(orcaStop
      ? {
          orcaStop: {
            ...orcaStop,
            ...(turnScope?.kind === 'turn' ? { turnItemId: turnScope.turnItemId } : {})
          }
        }
      : {})
  }
}
