// When an ACP chat reopens its conversation, the agent replays its whole saved history before it
// answers. Turns in it that the chat never saw (made in the agent's own CLI, or anywhere else) are
// added once, in the agent's order, after the chat's rows and behind one "Continued outside this
// chat." divider. Neither OpenCode nor Grok refuses a second writer, and the chat only learns what
// it streams itself, so its rows are re-derived against the agent's record on every open. The
// import is staged whole, then written as one settlement: no part of it is ever durable alone.

import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { agentSessionHostStatusBody } from '../../shared/agent-session-host-status-rows'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import {
  usableJournalHistoryOrigin,
  type JournalHistoryOrigin
} from '../native-chat/agent-session-journal/journal-history-origin'
import {
  journalLifecycleItemMutation,
  journalLifecycleMutationItemId
} from '../native-chat/agent-session-journal/journal-lifecycle-mutation'
import { createLegacyProviderTimelineIdentityScheme } from '../native-chat/agent-session-timeline/provider-timeline-identity'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { StructuredAgentSessionTransitionJournal } from '../native-chat/agent-session-wire/structured-agent-session-transition'
import {
  CODEX_RESTORE_MAX_BYTES as HISTORY_MAX_BYTES,
  CODEX_RESTORE_MAX_OPERATIONS as HISTORY_MAX_OPERATIONS
} from '../codex/codex-structured-journal-translation-restore'
import { AcpHistoryJournalOverlay } from './acp-history-journal-overlay'
import {
  acpHistoryTurns,
  type AcpIdentifiedHistoryTurn,
  type AcpLoadHistoryFrame
} from './acp-history-replay'
import { translateHistoryTurn, type AcpHistoryScope } from './acp-history-translation'
import { acpNativeTurns, matchAcpHistoryTurns } from './acp-history-turn-matching'

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
  const timeoutMs = input.timeoutMs ?? CATCH_UP_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('catch-up-deadline')), timeoutMs)
  const check = () => {
    if (Date.now() >= deadline) {
      throw new Error('catch-up-deadline')
    }
    input.assertCurrent()
  }
  const warn = (reason: string, error?: unknown) =>
    input.logger?.warn('ACP chat did not catch up on turns made outside it', {
      scope: 'acp-history-catch-up',
      sessionId: input.sessionId,
      reason,
      ...(error === undefined ? {} : { error })
    })
  try {
    const written = await waitForPromiseWithSignal(
      input.sink.written?.() ?? Promise.resolve({ ok: true }),
      controller.signal
    )
    check()
    const journal = input.sink.journalItems?.()
    const history = input.sink.journalHistory?.()
    if (!written.ok || !journal || !history || !input.sink.tryAppendTransition) {
      return
    }
    const plan = await planAcpHistoryImport(input, journal, history.historyOrigin(), check)
    if (!plan) {
      return
    }
    let resolved = false
    const admission = input.sink.tryAppendTransition({
      lifecycle: true,
      publish: true,
      steps: [
        {
          kind: 'settlement',
          settlementId: plan.settlementId,
          reservedBytes: plan.reservedBytes,
          resolve: (current) => {
            try {
              check()
            } catch {
              return []
            }
            // Planned against a journal that changed since: the next open plans again.
            if (
              current.epoch !== journal.epoch ||
              journalView(input, current) !== plan.view ||
              plan.keys.some((key) => current.item(current.canonicalItemId(key)) !== null)
            ) {
              return []
            }
            resolved = true
            return plan.mutations
          }
        }
      ]
    })
    if (!admission.accepted) {
      warn(admission.reason)
      return
    }
    const committed = await waitForPromiseWithSignal(
      input.sink.written?.() ?? Promise.resolve({ ok: true }),
      controller.signal
    )
    if (committed?.ok === false) {
      warn('write-failed', committed.error)
    } else if (!resolved) {
      warn('stale-history')
    }
  } catch (error) {
    warn('import-skipped', error)
  } finally {
    clearTimeout(timer)
  }
}

async function planAcpHistoryImport(
  input: AcpHistoryCatchUpInput,
  journal: StructuredAgentSessionTransitionJournal,
  origin: JournalHistoryOrigin | null,
  check: () => void
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
  const usable = usableJournalHistoryOrigin(origin)
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
    await setImmediate()
  }
  const mutations = overlay.created()
  const first = selected.find((turn) => !kind.has(turn.turn))
  if (mutations.length === 0) {
    return null
  }
  if (first && itemIds(journal).length > 0) {
    // The chat's last turn of its own is gone from the agent's history: the divider says so.
    const rewound = natives.length > 0 && ![...matched.values()].includes(natives.length - 1)
    mutations.unshift(
      journalLifecycleItemMutation(
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE },
        {
          provider: 'legacy',
          agent: input.agent,
          sessionId: input.sessionId,
          recordId: `continued-outside:${first.turn}`
        },
        agentSessionHostStatusBody(rewound ? 'continued-outside-rewound' : 'continued-outside')
      )
    )
  }
  const keys = mutations.map(journalLifecycleMutationItemId)
  const bytes = Buffer.byteLength(JSON.stringify(mutations), 'utf8')
  if (mutations.length > HISTORY_MAX_OPERATIONS || bytes > HISTORY_MAX_BYTES) {
    throw new Error('too-large')
  }
  const settlementId = `acp-history-import:${createHash('sha256')
    .update(JSON.stringify([journal.epoch, input.providerSessionId, keys]))
    .digest('hex')}`
  return {
    settlementId,
    mutations,
    keys,
    view: journalView(input, journal),
    // The existing batch envelope charge, plus the transition's one publication byte.
    reservedBytes: bytes + settlementId.length + 512
  }
}

/** The saved facts a plan read, compared again when its write runs. */
function journalView(
  scope: AcpHistoryScope,
  journal: StructuredAgentSessionTransitionJournal
): string {
  return createHash('sha256')
    .update(JSON.stringify([itemIds(journal), acpNativeTurns(scope, journal)]))
    .digest('hex')
}

function itemIds(journal: StructuredAgentSessionTransitionJournal): string[] {
  const ids: string[] = []
  journal.visitItems((itemId) => {
    ids.push(itemId)
  })
  return ids
}
