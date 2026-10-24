import type {
  AgentSessionExecutionLocation,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
import type { AgentChildWorkRecord } from '../../../shared/agent-status-child-work'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import {
  parseAgentStatusSubject,
  serializeAgentStatusSubject,
  type AgentStatusStructuredSessionSubject
} from '../../../shared/agent-status-subject'
import {
  StructuredAgentSessionOpenChildWork,
  type ChildWorkLifetimeToken
} from './structured-agent-session-open-child-work'
import {
  acceptedChildWork,
  finishChildWorkAdmission,
  type ChildWorkAdmission
} from './structured-agent-session-accepted-child-work'
import type { StructuredAgentSessionChildWorkProducer } from './structured-agent-session-subagent-rows'

export type StructuredAgentSessionStatusSink = {
  publish: (
    summary: AgentSessionStatusSummary,
    subject: AgentStatusStructuredSessionSubject
  ) => void
  forget: (subject: AgentStatusStructuredSessionSubject) => void
  /** The session's child-work evidence, addressed by the subject its parent row landed under. */
  publishChildWork?: (
    subject: AgentStatusStructuredSessionSubject,
    evidence: AgentChildWorkEvidence[],
    provider: AgentSessionRecord['provider']
  ) => void
  /** The child records the sink holds for that subject, as the views every surface reads. */
  readChildWork?: (subject: AgentStatusStructuredSessionSubject) => AgentChildWorkView[]
  /** The records those views project, with the host-only facts no view carries. */
  readChildWorkRecords?: (subject: AgentStatusStructuredSessionSubject) => AgentChildWorkRecord[]
  /** Every provider handle a live record of the subject answers to for its current run. */
  readChildWorkHandles?: (subject: AgentStatusStructuredSessionSubject) => ReadonlySet<string>
}

export type CapturedChildWorkStops = {
  current: (handleId: string) => boolean
  acknowledge: (evidence: readonly AgentChildWorkEvidence[]) => ChildWorkAdmission
}

/** Retain the owner address because record removal may precede the final status callback. */
export class StructuredAgentSessionStatusOwnership {
  private readonly subjects = new Map<string, AgentStatusStructuredSessionSubject>()
  // Why separate from `subjects`: the address must survive a throwing publish so teardown can still
  // forget a row that did land, but "we hold an address" is not evidence the row is there. Only a
  // publish that returned proves that, and only that proof may suppress the re-offer below.
  private readonly landed = new Set<string>()
  private readonly open = new StructuredAgentSessionOpenChildWork()

  constructor(private readonly sink: () => StructuredAgentSessionStatusSink | undefined) {}

  matchesLocation(sessionId: string, location: AgentSessionExecutionLocation): boolean {
    const subject = this.subjects.get(sessionId)
    return (
      this.landed.has(sessionId) &&
      subject?.executionHostId === location.executionHostId &&
      subject.wslDistro === location.wslDistro &&
      subject.workspaceId === location.workspaceId &&
      subject.workspaceKind === location.workspaceKind
    )
  }

  publish(summary: AgentSessionStatusSummary, location?: AgentSessionExecutionLocation): void {
    const sink = this.sink()
    if (!sink || (!location && !this.subjects.has(summary.sessionId))) {
      return
    }
    const subject = location
      ? parseAgentStatusSubject({
          ...location,
          kind: 'structured-session',
          sessionId: summary.sessionId
        })
      : this.subjects.get(summary.sessionId)
    if (!subject || subject.kind !== 'structured-session') {
      throw new Error('Structured status requires its full trusted execution location')
    }
    const previous = this.subjects.get(summary.sessionId)
    if (
      previous &&
      serializeAgentStatusSubject(previous) !== serializeAgentStatusSubject(subject)
    ) {
      sink.forget(previous)
    }
    this.subjects.set(summary.sessionId, subject)
    this.landed.delete(summary.sessionId)
    sink.publish(summary, subject)
    this.landed.add(summary.sessionId)
  }

  /** Children ride the address the parent landed under: without that proof the store would
   *  refuse them anyway, and offering them earlier would race the parent row. The open set takes
   *  every edge regardless, since that gate is the store's, not the provider's. */
  publishChildWork(
    sessionId: string,
    evidence: AgentChildWorkEvidence[],
    provider: AgentSessionRecord['provider'],
    producer?: StructuredAgentSessionChildWorkProducer,
    capture?: Parameters<typeof acceptedChildWork>[2],
    published?: () => void
  ): ChildWorkAdmission {
    const changes = this.open.observe(sessionId, evidence)
    return acceptedChildWork(changes, producer, capture, () => {
      const subject = this.subjects.get(sessionId)
      if (subject && this.landed.has(sessionId)) {
        try {
          this.sink()?.publishChildWork?.(subject, evidence, provider)
        } finally {
          published?.()
        }
      } else {
        published?.()
      }
    })()
  }

  /** A Stop's callback closes only lifetimes captured before the provider call can await. */
  captureChildWorkStops(sessionId: string, handleIds: readonly string[]): CapturedChildWorkStops {
    const captured = new Map<string, ChildWorkLifetimeToken | undefined>()
    for (const handleId of handleIds) {
      captured.set(handleId, this.open.capture(sessionId, handleId))
    }
    return {
      current: (handleId) =>
        captured.has(handleId) && this.open.matches(sessionId, handleId, captured.get(handleId)),
      acknowledge: (evidence) => {
        const changes = evidence.flatMap((edge) => {
          if (edge.type !== 'stop-acknowledged') {
            return []
          }
          const token = captured.get(edge.handleId)
          const change = token && this.open.stopped(sessionId, edge.handleId, token)
          return change ? [change] : []
        })
        const append = acceptedChildWork(changes)
        const producer = changes[0]?.token.journalWork?.producer
        const admission = producer?.continueWork?.(append) ?? append()
        void finishChildWorkAdmission(admission, producer).then((result) => {
          if (!result.ok) {
            console.warn('[agent-session] captured Stop ended unwritten', result.error)
          }
        })
        return admission
      }
    }
  }

  /** Whether the session's provider reported child work running that has not ended. */
  childWorkOpen(sessionId: string): boolean {
    return this.open.hasOpen(sessionId)
  }

  /** Whether some of that work has no record, whatever kept it out of the store. */
  childWorkIncomplete(sessionId: string): boolean {
    const open = this.open.handles(sessionId)
    if (!open) {
      return false
    }
    const read = this.sink()?.readChildWorkHandles
    if (!read) {
      return true
    }
    const subject = this.subjects.get(sessionId)
    const recorded = subject && this.landed.has(sessionId) ? read(subject) : new Set<string>()
    return [...open].some((handleId) => !recorded.has(handleId))
  }

  /** Undefined until the parent row has landed: a sink holds no children for a parent it lacks. */
  readChildWork(sessionId: string): AgentChildWorkView[] | undefined {
    const subject = this.subjects.get(sessionId)
    return subject && this.landed.has(sessionId) ? this.sink()?.readChildWork?.(subject) : undefined
  }

  readChildWorkRecords(sessionId: string): AgentChildWorkRecord[] | undefined {
    const subject = this.subjects.get(sessionId)
    return subject && this.landed.has(sessionId)
      ? this.sink()?.readChildWorkRecords?.(subject)
      : undefined
  }

  forget(sessionId: string): void {
    this.open.forget(sessionId)
    const subject = this.subjects.get(sessionId)
    if (!subject) {
      return
    }
    this.landed.delete(sessionId)
    this.sink()?.forget(subject)
    this.subjects.delete(sessionId)
  }
}
