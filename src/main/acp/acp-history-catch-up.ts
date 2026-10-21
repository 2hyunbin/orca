// When an ACP chat reopens its conversation, the agent replays its whole saved history before it
// answers. Turns in it that the chat never saw (made in the agent's own CLI, or anywhere else) are
// added once, in the agent's order, after the chat's rows and behind one "Continued outside this
// chat." divider. Neither OpenCode nor Grok refuses a second writer, and the chat only learns what
// it streams itself, so its rows are re-derived against the agent's record on every open. The
// shared runner owns the open envelope and the one checked commit; this reads the replay.

import { createHash } from 'node:crypto'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import { usableJournalHistoryOrigin } from '../native-chat/agent-session-journal/journal-history-origin'
import {
  journalLifecycleItemMutation,
  journalLifecycleMutationItemId,
  type JournalLifecycleIdentityMutationInput
} from '../native-chat/agent-session-journal/journal-lifecycle-mutation'
import { createLegacyProviderTimelineIdentityScheme } from '../native-chat/agent-session-timeline/provider-timeline-identity'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  continuedOutsideNotice,
  continuedOutsideRecordId,
  createHistoryCatchUpBatch,
  runHistoryCatchUp,
  type HistoryCatchUpContext
} from '../native-chat/agent-session-wire/structured-agent-session-history-catch-up'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { AcpHistoryJournalOverlay } from './acp-history-journal-overlay'
import {
  acpHistoryTurns,
  type AcpIdentifiedHistoryTurn,
  type AcpLoadHistoryFrame
} from './acp-history-replay'
import { translateHistoryTurn, type AcpHistoryScope } from './acp-history-translation'
import {
  acpNativeTurns,
  matchAcpHistoryTurns,
  type AcpHistoryReadJournal
} from './acp-history-turn-matching'
import { acpAgentName } from './acp-structured-agent-definitions'

const CATCH_UP_TIMEOUT_MS = 30_000

export type AcpHistoryCatchUpInput = AcpHistoryScope & {
  frames: readonly AcpLoadHistoryFrame[]
  sink: StructuredAgentSessionEventSink
  /** Throws once the start this runs in is over. */
  assertCurrent: () => void
  timeoutMs?: number
  logger?: StructuredAgentSessionLogger
}

/** Optional reconciliation: it never fails the open, and a stale or failed one writes nothing. */
export async function catchUpAcpHistory(input: AcpHistoryCatchUpInput): Promise<void> {
  await runHistoryCatchUp({
    agentName: acpAgentName(input.agent),
    scope: 'acp-history-catch-up',
    sessionId: input.sessionId,
    sink: input.sink,
    assertCurrent: input.assertCurrent,
    timeoutMs: input.timeoutMs ?? CATCH_UP_TIMEOUT_MS,
    ...(input.logger ? { logger: input.logger } : {}),
    readView: (history) => journalView(input, history),
    sameView: (planned, current) => planned === current,
    prepare: (context) => planAcpHistoryImport(input, context)
  })
}

async function planAcpHistoryImport(
  input: AcpHistoryCatchUpInput,
  { journal, history, check, yieldTurn }: HistoryCatchUpContext<string>
) {
  const turns = acpHistoryTurns(input.frames, input.identity).filter(
    (turn): turn is AcpIdentifiedHistoryTurn => turn.turn !== null
  )
  if (turns.length === 0) {
    return null
  }
  const scheme = createLegacyProviderTimelineIdentityScheme({
    agent: input.agent,
    sessionId: input.sessionId
  })
  const turnRowKey = (turn: string) =>
    agentJournalItemKey(
      scheme.turn({ namespace: input.providerSessionId, key: { source: 'provider', value: turn } })
    )
  const usable = usableJournalHistoryOrigin(history.historyOrigin())
  const handle = usable?.providerHandle
  const importedAt =
    usable &&
    handle?.kind === 'opaque' &&
    handle.agent === input.agent &&
    handle.value === input.providerSessionId
      ? usable.importedAt
      : null
  check()
  const { natives, kind, matched } = matchAcpHistoryTurns(
    input,
    journal,
    turns,
    turnRowKey,
    importedAt
  )
  // Turns the chat lacks, and turns an earlier catch-up added, which get what the agent saved since.
  const selected = turns.filter((turn) => kind.get(turn.turn) !== 'native')
  const overlay = new AcpHistoryJournalOverlay(journal)
  for (const turn of selected) {
    check()
    translateHistoryTurn(input, overlay, turn)
    await yieldTurn()
  }
  const created = overlay.created()
  if (created.length === 0) {
    return null
  }
  const batch = createHistoryCatchUpBatch()
  const first = selected.find((turn) => !kind.has(turn.turn))
  if (first && itemIds(journal).length > 0) {
    // The chat's last turn of its own is gone from the agent's history: the divider says so.
    const rewound = natives.length > 0 && ![...matched.values()].includes(natives.length - 1)
    batch.push(
      journalLifecycleItemMutation(
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE },
        {
          provider: 'legacy',
          agent: input.agent,
          sessionId: input.sessionId,
          recordId: continuedOutsideRecordId(first.turn)
        },
        continuedOutsideNotice(rewound)
      )
    )
  }
  for (const mutation of created) {
    batch.push(withIdentity(mutation))
  }
  return batch.finish('acp-history-import', [
    journal.epoch,
    input.providerSessionId,
    created.map(journalLifecycleMutationItemId)
  ])
}

/** Every row the assembler writes is keyed by an identity the journal can parse back. */
function withIdentity(
  mutation: ReturnType<AcpHistoryJournalOverlay['created']>[number]
): JournalLifecycleIdentityMutationInput {
  if (mutation.identity) {
    return { ...mutation, identity: mutation.identity }
  }
  const { itemId, ...rest } = mutation
  const identity = parseAgentJournalItemKey(itemId)
  if (!identity) {
    throw new Error('unkeyed-history-row')
  }
  return { ...rest, identity }
}

/** The saved facts a plan read, compared again when its write runs. */
function journalView(scope: AcpHistoryScope, journal: AcpHistoryReadJournal): string {
  return createHash('sha256')
    .update(JSON.stringify([itemIds(journal), acpNativeTurns(scope, journal)]))
    .digest('hex')
}

function itemIds(journal: AcpHistoryReadJournal): string[] {
  const ids: string[] = []
  journal.visitItems((itemId) => {
    ids.push(itemId)
  })
  return ids
}
