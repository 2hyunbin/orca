import type {
  AgentJournalTurnLifecycle,
  AgentJournalTurnOutcome
} from '../../shared/agent-session-journal-types'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  CODEX_JOURNAL_ADMITTED,
  type CodexJournalTranslationAdmission
} from './codex-structured-journal-contracts'
import type { CodexJournalItems } from './codex-structured-journal-items'
import { settleCodexJournalTurn } from './codex-structured-journal-settlement'
import {
  CodexJournalRecentTurns,
  type CodexJournalActiveTurns
} from './codex-structured-journal-translation-turn-state'
import type { CodexDispatchRequestOrigin } from './codex-structured-dispatch-echo'
import type { CodexDispatchObservations } from './codex-structured-dispatch-observations'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import {
  codexTurnLifecycleState,
  codexTurnOutcome,
  codexTurnUserItemId,
  publishCodexTurnLifecycle
} from './codex-structured-journal-translation-turns'
import type { CodexPendingJournalPrompt } from './codex-structured-journal-settlement'
import {
  readCodexTurnDurationMs,
  readCodexTurnId,
  readCodexTurnStatus
} from './codex-structured-thread-facts'
import type { CodexRowAttribution } from './codex-subagent-linkage'
import type { CodexJournalCommandTurn } from './codex-journal-command-turn'
import { readRecord, readString } from './codex-item-field-readers'
import { recordCodexCommandTurnClaim } from './codex-command-turn-claim'

type TurnBoundaryEvent = {
  sessionId: string
  threadId: string
  params: unknown
  observedAt?: number
  dispatchSequenceAtReceipt?: number
}

/** Who ended the turn travels with the end, so a host inference never reads as Codex's own. */
type TurnTerminal = Pick<AgentJournalTurnLifecycle, 'receiptsComplete' | 'blockedInput'> & {
  state: 'completed' | 'interrupted'
  completedAt: number
  /** Null when Codex named no verdict, or when the host inferred this end itself. */
  outcome?: AgentJournalTurnOutcome | null
  durationMs?: number | null
  endedBy: 'provider' | 'host'
}

/** Opens and settles the durable lifecycle row for each primary-thread turn. */
export class CodexJournalTurnBoundaries {
  private readonly recentTurns = new CodexJournalRecentTurns()
  /** Why a prompt hook blocked input in a running primary turn (`blockedInputKey`). */
  private readonly blockedInputs = new Map<string, string>()

  constructor(
    private readonly deps: {
      sink: StructuredAgentSessionEventSink
      primaryThreadId: () => string | null
      activeTurns: CodexJournalActiveTurns
      items: Pick<CodexJournalItems, 'streams' | 'activeItems' | 'ordinals'>
      pendingPrompts: Map<string, CodexPendingJournalPrompt>
      clearPromptTurn?: (threadId: string, turnId: string) => void
      flushSuppression: () => CodexJournalTranslationAdmission
      resetActivity: (threadId: string) => void
      attributionFor: CodexRowAttribution
      commands: CodexJournalCommandTurn
      observations?: Pick<CodexDispatchObservations, 'certifies' | 'retained' | 'prune' | 'lose'>
      now?: () => number
    }
  ) {}

  start(event: TurnBoundaryEvent): CodexJournalTranslationAdmission {
    const turnId = readCodexTurnId(event.params)
    if (!turnId) {
      return CODEX_JOURNAL_ADMITTED
    }
    if (!this.deps.activeTurns.canRemember(event.threadId, turnId)) {
      return { accepted: false, reason: 'backpressure' }
    }
    const startedAt = this.receiptTime(event)
    const command =
      event.threadId === this.deps.primaryThreadId() ? this.deps.commands.claim(turnId) : null
    // The command's turn is the record: this turn writes none, and its rows join the command's.
    const admission = command
      ? recordCodexCommandTurnClaim(this.deps.sink, agentJournalItemKey(command.identity), turnId)
      : publishCodexTurnLifecycle({
          sink: this.deps.sink,
          primaryThreadId: this.deps.primaryThreadId(),
          sessionId: event.sessionId,
          threadId: event.threadId,
          turnId,
          state: 'running',
          startedAt
        })
    if (admission.accepted) {
      this.deps.activeTurns.remember(
        event.threadId,
        turnId,
        startedAt,
        event.dispatchSequenceAtReceipt
      )
      this.deps.resetActivity(event.threadId)
    }
    return admission
  }

  /** Revises a turn only after Codex echoes the exact send inside it. */
  attributeRequest(input: {
    sessionId: string
    clientMessageId: string
    threadId: string
    turnId: string
    requestOrigin: CodexDispatchRequestOrigin
  }): CodexJournalTranslationAdmission {
    if (input.threadId !== this.deps.primaryThreadId()) {
      return CODEX_JOURNAL_ADMITTED
    }
    const requestOrigin = {
      ...input.requestOrigin,
      userItemId: agentJournalSubmissionKey(input.clientMessageId)
    }
    const activeRevision = this.deps.activeTurns.requestOriginRevision(
      input.threadId,
      input.turnId,
      requestOrigin
    )
    const settledRevision = activeRevision
      ? null
      : this.recentTurns.requestOriginRevision(input.threadId, input.turnId, requestOrigin)
    const revision = activeRevision ?? settledRevision
    if (!revision) {
      return CODEX_JOURNAL_ADMITTED
    }
    const admission = publishCodexTurnLifecycle({
      sink: this.deps.sink,
      primaryThreadId: this.deps.primaryThreadId(),
      sessionId: input.sessionId,
      threadId: input.threadId,
      turnId: input.turnId,
      state: settledRevision?.state ?? 'running',
      ...revision
    })
    if (admission.accepted) {
      if (activeRevision) {
        this.deps.activeTurns.rememberRequestOrigin(input.threadId, input.turnId, requestOrigin)
      } else if (settledRevision) {
        this.recentTurns.remember(input.threadId, settledRevision, requestOrigin)
      }
    }
    return admission
  }

  /** Codex ends every turn with exactly one `turn/completed`, a failed one after
   *  its `error` frame included, so this is the only live end. */
  complete(event: TurnBoundaryEvent): CodexJournalTranslationAdmission {
    const suppressionAdmission = this.deps.flushSuppression()
    if (!suppressionAdmission.accepted) {
      return suppressionAdmission
    }
    const namedTurnId = readCodexTurnId(event.params)
    const turnId = namedTurnId ?? this.deps.activeTurns.current(event.threadId)
    if (!turnId) {
      return CODEX_JOURNAL_ADMITTED
    }
    // The roster is deliberately NOT swept here. `spawn_agent` children outlive
    // the turn that spawned them and go on reporting into the same group, so a
    // turn boundary is no evidence contact was lost. Only `settleSession` may
    // write `unverifiable`.
    const status = readCodexTurnStatus(event.params)
    const completedAt = this.receiptTime(event)
    const commandEnd = this.deps.commands.end(turnId, {
      status,
      error: readString(readRecord(readRecord(readRecord(event.params).turn).error), 'message'),
      completedAt
    })
    // Codex records a turn's prompt only once the turn starts, so an interrupted turn this child
    // never started, with no item or prompt read, ran nothing and gets no record: the Stop that
    // took it settles its send.
    const ranNothing =
      status === 'interrupted' &&
      !this.deps.activeTurns.has(event.threadId, turnId) &&
      !this.deps.items.ordinals.hasItems(event.threadId, turnId) &&
      ![...this.deps.pendingPrompts.values()].some(
        (prompt) => prompt.threadId === event.threadId && prompt.turnId === turnId
      )
    const turnLifecycle =
      this.ownsRecord(event.threadId, turnId) && !ranNothing
        ? this.settled(event.threadId, turnId, {
            state: codexTurnLifecycleState(status),
            outcome: codexTurnOutcome(status),
            completedAt,
            durationMs: readCodexTurnDurationMs(event.params),
            endedBy: 'provider',
            // Only a named, recognized end of a start this child saw, with its capture whole.
            ...(namedTurnId !== null &&
            codexTurnOutcome(status) !== null &&
            this.deps.activeTurns.has(event.threadId, turnId) &&
            this.deps.observations?.certifies()
              ? { receiptsComplete: true as const }
              : {}),
            ...this.blockedInput(event.threadId, turnId)
          })
        : null
    const requestOrigin = this.deps.activeTurns.requestOrigin(event.threadId, turnId)
    const latestDispatchSequence = this.deps.activeTurns.latestDispatchSequence(
      event.threadId,
      turnId
    )
    const admission = settleCodexJournalTurn({
      sink: this.deps.sink,
      sessionId: event.sessionId,
      threadId: event.threadId,
      turnId,
      turnLifecycle,
      completedAt,
      turnEnd: codexTurnLifecycleState(status),
      streams: this.deps.items.streams,
      activeItems: this.deps.items.activeItems,
      pendingPrompts: this.deps.pendingPrompts,
      ...(this.deps.clearPromptTurn ? { clearPromptTurn: this.deps.clearPromptTurn } : {}),
      attributionFor: this.deps.attributionFor,
      commandEnd,
      ...(turnLifecycle && this.deps.observations
        ? {
            observed: {
              sends: this.deps.observations.retained(),
              saved: this.deps.observations.prune,
              lose: this.deps.observations.lose
            }
          }
        : {})
    })
    if (admission.accepted) {
      if (turnLifecycle) {
        this.recentTurns.remember(
          event.threadId,
          turnLifecycle,
          requestOrigin,
          latestDispatchSequence
        )
      }
      this.deps.items.ordinals.forgetTurn(event.threadId, turnId)
      this.blockedInputs.delete(blockedInputKey(event.threadId, turnId))
      this.deps.activeTurns.forget(event.threadId, turnId)
      this.deps.commands.settled(turnId)
      this.deps.resetActivity(event.threadId)
    }
    return admission
  }

  /** Terminal lifecycle for a remembered turn; `startedAt` is absent when the start was never seen.
   *  The verdict travels as one record so a caller cannot supply the state and drop the outcome. */
  settled(threadId: string, turnId: string, terminal: TurnTerminal): AgentJournalTurnLifecycle {
    const startedAt = this.deps.activeTurns.startedAt(threadId, turnId)
    // Carried forward from the exact echoed send that was attributed to this turn.
    const requestOrigin = this.deps.activeTurns.requestOrigin(threadId, turnId)
    return {
      turnId,
      state: terminal.state,
      ...(terminal.outcome ? { outcome: terminal.outcome } : {}),
      userItemId: requestOrigin?.userItemId ?? codexTurnUserItemId(threadId, turnId),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(requestOrigin !== undefined ? { requestedAt: requestOrigin.requestedAt } : {}),
      completedAt: terminal.completedAt,
      ...(terminal.durationMs != null ? { durationMs: terminal.durationMs } : {}),
      endedBy: terminal.endedBy,
      ...(terminal.receiptsComplete ? { receiptsComplete: true } : {}),
      ...(terminal.blockedInput ? { blockedInput: terminal.blockedInput } : {})
    }
  }

  /** A `hook/completed` whose prompt hook blocked input in the running primary turn it names. */
  observeHook(event: TurnBoundaryEvent): void {
    const run = readRecord(readRecord(event.params).run)
    const turnId = readCodexTurnId(event.params)
    if (
      !turnId ||
      run.status !== 'blocked' ||
      run.eventName !== 'userPromptSubmit' ||
      event.threadId !== this.deps.primaryThreadId() ||
      !this.deps.activeTurns.has(event.threadId, turnId)
    ) {
      return
    }
    const entries = Array.isArray(run.entries) ? run.entries.map(readRecord) : []
    const feedback = entries.find((entry) => entry.kind === 'feedback')
    const reason = typeof feedback?.text === 'string' ? feedback.text : ''
    this.blockedInputs.set(
      blockedInputKey(event.threadId, turnId),
      boundInlineText(reason, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
    )
  }

  private blockedInput(threadId: string, turnId: string): Pick<TurnTerminal, 'blockedInput'> {
    const reason = this.blockedInputs.get(blockedInputKey(threadId, turnId))
    return reason === undefined ? {} : { blockedInput: { reason } }
  }

  /** Whether this translator writes the turn's record: a primary turn no command claimed. */
  ownsRecord(threadId: string, turnId: string): boolean {
    return threadId === this.deps.primaryThreadId() && !this.deps.commands.isCarrying(turnId)
  }

  clear(): void {
    this.deps.activeTurns.clear()
    this.recentTurns.clear()
    this.blockedInputs.clear()
    this.deps.commands.clear()
  }

  private receiptTime(event: TurnBoundaryEvent): number {
    return event.observedAt ?? this.deps.now?.() ?? Date.now()
  }
}

function blockedInputKey(threadId: string, turnId: string): string {
  return JSON.stringify([threadId, turnId])
}
