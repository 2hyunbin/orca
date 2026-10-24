import type { StructuredAgentSessionSinkBarrier } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ChildWorkAdmission } from '../native-chat/agent-session-wire/structured-agent-session-accepted-child-work'
// One ACP child's path into the journal: the translator turns its traffic into grammar events, and
// the shared assembler writes them. Events apply strictly in order; one the sink refuses under
// backpressure holds every later one until the sink drains, so nothing is reordered or dropped.

import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  createProviderTimelineAssembler,
  type ProviderTimelineAssembler
} from '../native-chat/agent-session-timeline/provider-timeline-assembler'
import type { AcpTimelineEvent } from './acp-timeline-event'
import { createLegacyProviderTimelineIdentityScheme } from '../native-chat/agent-session-timeline/provider-timeline-identity'
import type { ProviderTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import type { StructuredAgentSessionCommandRun } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AcpChildStops, AcpDialect } from './acp-dialects/acp-dialect'
import { AcpTimelineTranslator } from './acp-timeline-translator'
import {
  acpBackgroundTaskChildWork,
  isAcpBackgroundTaskChildWorkEvent
} from './acp-background-task-child-work'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import {
  neverThrowingStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { AcpTextDrop } from './acp-turn-messages'

/** How long a held event waits for the sink to say it drained before trying again on its own. */
const BACKPRESSURE_RETRY_MS = 250

/** Subagent evidence holds its place among the events: it reaches the host only after the journal
 *  wrote what came before it. */
type SubagentWork = {
  type: 'subagent.work'
  evidence: AgentChildWorkEvidence[]
  retry?: () => ChildWorkAdmission
}

export type AcpStructuredLaneDeps = {
  sink: ProviderTimelineSink
  sessionId: string
  agent: string
  /** The agent's name as a person reads it, for the rows that name it. */
  agentName: string
  generation: string
  providerSessionId: string
  dialect: AcpDialect
  logger: StructuredAgentSessionLogger
  /** A send of Orca's reached the agent: the turn it opened has its first provider event. */
  onInputAccepted: (clientMessageId: string) => void
  /** The sink refused for good; nothing more this child says can be journaled. */
  onFailed: (reason: string) => void
  onChildWorkEvidence?: (evidence: AgentChildWorkEvidence[]) => ChildWorkAdmission | void
  onChildWorkFailure?: (error: unknown) => void
  now?: () => number
  childStops?: () => AcpChildStops
}

export class AcpStructuredLane {
  readonly translator: AcpTimelineTranslator
  private readonly assembler: ProviderTimelineAssembler
  private readonly backlog: (AcpTimelineEvent | SubagentWork)[] = []
  private readonly turnWatchers = new Set<() => void>()
  private readonly requestIdentity: ReturnType<typeof createLegacyProviderTimelineIdentityScheme>
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private failed = false
  private ended = false
  private disposed = false
  private disposing = false
  private admittedStages = 0
  private disposal?: Promise<StructuredAgentSessionSinkBarrier>
  private readonly logger: StructuredAgentSessionLogger

  constructor(private readonly deps: AcpStructuredLaneDeps) {
    this.logger = neverThrowingStructuredAgentSessionLogger(deps.logger)
    this.translator = new AcpTimelineTranslator({
      sessionId: deps.providerSessionId,
      dialect: deps.dialect,
      agentName: deps.agentName,
      onTextDropped: (drop) => this.reportTextDrop(drop)
    })
    this.requestIdentity = createLegacyProviderTimelineIdentityScheme({
      agent: deps.agent,
      sessionId: deps.sessionId
    })
    this.assembler = createProviderTimelineAssembler({
      sink: deps.sink,
      sessionId: deps.sessionId,
      agent: deps.agent,
      generation: deps.generation,
      namespace: deps.providerSessionId
    })
  }

  get openTurnId(): string | null {
    return this.assembler.openTurnId
  }

  /** The host already opened this command's turn; the agent's frames and end join that turn. */
  beginCommand(command: StructuredAgentSessionCommandRun): void {
    if (this.failed || this.disposed || this.backlog.length > 0) {
      throw new Error('ACP timeline has not drained for this command')
    }
    this.assembler.beginCommand(command)
  }

  forgetCommand(turnId: string): void {
    this.assembler.forgetCommand(turnId)
  }

  apply(events: readonly AcpTimelineEvent[]): void {
    if (this.failed || this.disposed || this.disposing) {
      return
    }
    this.backlog.push(...events)
    const evidence = this.translator.subagents.drainEvidence()
    if (evidence.length > 0 && !this.ended) {
      this.backlog.push({ type: 'subagent.work', evidence })
    }
    this.drain()
  }

  /** Resolves once `turnId` is no longer the open turn, or nothing more can be written. */
  whenTurnLeaves(turnId: string): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.failed || this.disposed || this.openTurnId !== turnId) {
          this.turnWatchers.delete(check)
          resolve()
        }
      }
      this.turnWatchers.add(check)
      check()
    })
  }

  continueWork = (append: () => ChildWorkAdmission): ChildWorkAdmission => {
    if (this.failed || this.disposed || this.disposing) {
      return { accepted: false, reason: this.failed ? 'failed' : 'closed' }
    }
    this.backlog.push({ type: 'subagent.work', evidence: [], retry: append })
    this.drain()
    return { accepted: true }
  }

  /** The sink drained: whatever it held back goes now. */
  retry(): void {
    this.drain()
  }

  /** Whether the journal row `itemId` is the row of request `requestKey`, which the assembler
   *  writes under this acquisition's generation (any incarnation a reused key adds). */
  isRequestRow(itemId: string, requestKey: string): boolean {
    const identity = parseAgentJournalItemKey(itemId)
    if (identity?.provider !== 'legacy' || identity.sessionId !== this.deps.sessionId) {
      return false
    }
    const first = this.requestIdentity.request({
      generation: this.deps.generation,
      key: requestKey,
      incarnation: 1
    })
    const prefix = first.provider === 'legacy' ? first.recordId : null
    return identity.recordId === prefix || identity.recordId.startsWith(`${prefix}#`)
  }

  flush(): void {
    this.assembler.flush()
  }

  written = async (): Promise<StructuredAgentSessionSinkBarrier> => {
    if (this.disposal) {
      return this.disposal
    }
    while (this.backlog.length && !this.failed && !this.disposed) {
      const before = this.admittedStages
      const landed = await this.deps.sink.written?.()
      if (landed && !landed.ok) {
        return landed
      }
      this.drain()
      if (this.admittedStages === before && this.backlog.length) {
        return { ok: false, error: new Error('ACP normalized suffix was not admitted after drain') }
      }
    }
    if (this.failed || (this.disposed && this.backlog.length)) {
      return { ok: false, error: new Error('ACP observation ended with unwritten work') }
    }
    return (await this.deps.sink.written?.()) ?? { ok: true }
  }

  dispose(): void {
    if (this.disposal) {
      return
    }
    this.disposing = true
    this.translator.dispose()
    const evidence: AgentChildWorkEvidence[] = [
      { type: 'session-ended', observedAt: this.deps.now?.() ?? Date.now() }
    ]
    if (!this.ended && !this.failed) {
      this.backlog.push({
        type: 'subagent.work',
        evidence
      })
    }
    const draining = this.written()
    this.disposal = draining
      .catch((error: unknown) => ({ ok: false as const, error }))
      .then((result) => {
        this.disposed = true
        this.clearRetry()
        this.assembler.dispose()
        this.notifyTurnWatchers()
        if (!result.ok) {
          this.publishEvidence(evidence)
          this.deps.onChildWorkFailure?.(result.error)
        }
        return result
      })
  }

  private drain(): void {
    this.clearRetry()
    while (this.backlog.length > 0 && !this.failed && !this.disposed) {
      const event = this.backlog[0]
      if (event.type === 'subagent.work') {
        if (!this.queueSubagentWork(event)) {
          return
        }
        this.admittedStages++
        this.backlog.shift()
        continue
      }
      const { admission, dropped } = this.assembler.apply(event)
      if (dropped === 'stream-mismatch' && event.type === 'text.delta') {
        this.reportTextDrop({
          reason: dropped,
          itemId: 'id' in event.item ? event.item.id : undefined,
          channel: event.channel,
          threadId: event.join?.thread,
          turnId: event.join?.turn,
          producerAgentId: event.producer?.agentId
        })
      }
      if (!admission.accepted) {
        this.refused(admission.reason)
        return
      }
      this.admittedStages++
      const evidence =
        event.type === 'session.ended'
          ? [{ type: 'session-ended' as const, observedAt: this.deps.now?.() ?? Date.now() }]
          : dropped === undefined && isAcpBackgroundTaskChildWorkEvent(event)
            ? acpBackgroundTaskChildWork(
                event,
                this.deps.now?.() ?? Date.now(),
                this.deps.childStops?.().backgroundTasks === true
              )
            : []
      this.backlog.shift()
      if (evidence.length) {
        this.backlog.unshift({ type: 'subagent.work', evidence })
      }
      this.ended ||= event.type === 'session.ended' && dropped === undefined
      if (event.type === 'input.accepted') {
        this.deps.onInputAccepted(event.clientMessageId)
      }
    }
    this.notifyTurnWatchers()
  }

  private refused(reason: string): void {
    if (reason === 'backpressure') {
      this.retryTimer = setTimeout(() => this.drain(), BACKPRESSURE_RETRY_MS)
      return
    }
    this.failed = true
    this.backlog.length = 0
    this.notifyTurnWatchers()
    this.deps.onFailed(reason)
  }

  /** False when the sink held it back; it stays first in the backlog. */
  private queueSubagentWork(event: SubagentWork): boolean {
    const stoppable = this.deps.childStops?.().subagents === true
    const admission =
      event.retry?.() ??
      this.publishEvidence(
        event.evidence.map((edge) =>
          edge.type === 'live' && edge.child.kind === 'agent'
            ? { ...edge, child: { ...edge.child, stoppable: stoppable && edge.child.stoppable } }
            : edge
        )
      )
    if (!admission.accepted) {
      event.retry = admission.retry
      this.refused(admission.reason)
    }
    return admission.accepted
  }

  private publishEvidence(evidence: AgentChildWorkEvidence[]): ChildWorkAdmission {
    try {
      return this.deps.onChildWorkEvidence?.(evidence) ?? { accepted: true }
    } catch (error) {
      this.deps.onChildWorkFailure?.(error)
      return { accepted: false, reason: 'failed' }
    }
  }

  private notifyTurnWatchers(): void {
    for (const check of this.turnWatchers) {
      check()
    }
  }

  private reportTextDrop(drop: AcpTextDrop): void {
    this.logger.warn('ACP text chunk rejected by its message stream', {
      scope: `acp-text-${drop.reason}`,
      sessionId: this.deps.sessionId,
      providerSessionId: this.deps.providerSessionId,
      agent: this.deps.agent,
      generation: this.deps.generation,
      ...drop
    })
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }
}

export { acpLaneChildWorkDelivery } from './acp-structured-child-work-delivery'
