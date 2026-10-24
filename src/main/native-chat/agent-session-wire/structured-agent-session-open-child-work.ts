// Track provider-reported work even when display admission rejects its records.

import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
import { isLiveChildWork } from '../../../shared/agent-status-child-work-liveness'
import { randomUUID } from 'node:crypto'
import type { AgentJournalTurnScope } from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionChildWorkProducer } from './structured-agent-session-subagent-rows'

export type ChildWorkLifetimeToken = {
  readonly childWorkLifetime: true
  readonly invocationId: string
  journalWork?: {
    producer: StructuredAgentSessionChildWorkProducer
    turnScope?: AgentJournalTurnScope
  }
}
const newToken = (): ChildWorkLifetimeToken => ({
  childWorkLifetime: true,
  invocationId: randomUUID()
})

type ChildLifetime = {
  start?: Extract<AgentChildWorkEvidence, { type: 'live' }>
  run: string | undefined
  previous: Set<string>
  token: ChildWorkLifetimeToken
  closed: 'idle' | 'terminal' | 'stopped' | null
}
export type ChildWorkChange = {
  token: ChildWorkLifetimeToken
  start: Extract<AgentChildWorkEvidence, { type: 'live' }>
  phase: 'open' | 'settled' | 'interrupted'
}

type SessionWork = {
  history: Map<string, ChildLifetime>
  open: Set<string>
}

export class StructuredAgentSessionOpenChildWork {
  private readonly sessions = new Map<string, SessionWork>()

  observe(sessionId: string, evidence: readonly AgentChildWorkEvidence[]): ChildWorkChange[] {
    const changes: ChildWorkChange[] = []
    for (const edge of evidence) {
      if (edge.type === 'session-ended') {
        for (const child of this.sessions.get(sessionId)?.history.values() ?? []) {
          if (child.start && child.closed === null) {
            changes.push({ token: child.token, start: child.start, phase: 'interrupted' })
          }
        }
        this.sessions.delete(sessionId)
      } else if (edge.type === 'live') {
        const previous = this.sessions.get(sessionId)?.history.get(edge.child.handle.id)
        const before = previous && { ...previous }
        this.live(
          sessionId,
          edge.child.handle.id,
          edge.child.handle.runId,
          edge.restart === true,
          isLiveChildWork(edge.child)
        )
        const after = this.sessions.get(sessionId)?.history.get(edge.child.handle.id)
        if (!after || (before?.token === after.token && before.closed === after.closed)) {
          continue
        }
        if (before?.start && before.closed === null && before.token !== after.token) {
          changes.push({ token: before.token, start: before.start, phase: 'interrupted' })
        }
        if (before?.token !== after.token) {
          after.start = edge
        }
        if (after.start) {
          changes.push({
            token: after.token,
            start: after.start,
            phase: after.closed === null ? 'open' : 'settled'
          })
        }
      } else if (edge.type === 'ended' || edge.type === 'removed') {
        const before = this.capture(sessionId, edge.handle.id)
        this.end(sessionId, edge.handle.id, edge.handle.runId)
        const after = this.sessions.get(sessionId)?.history.get(edge.handle.id)
        if (before && after?.start && !this.capture(sessionId, edge.handle.id)) {
          changes.push({ token: after.token, start: after.start, phase: 'settled' })
        }
      }
    }
    return changes
  }

  /** Capture before Stop; reused run strings still require distinct lifetime tokens. */
  capture(sessionId: string, handleId: string): ChildWorkLifetimeToken | undefined {
    const session = this.sessions.get(sessionId)
    return session?.open.has(handleId) ? session.history.get(handleId)?.token : undefined
  }

  matches(
    sessionId: string,
    handleId: string,
    captured: ChildWorkLifetimeToken | undefined
  ): boolean {
    return this.capture(sessionId, handleId) === captured
  }

  stopped(
    sessionId: string,
    handleId: string,
    token: ChildWorkLifetimeToken
  ): ChildWorkChange | undefined {
    const session = this.sessions.get(sessionId)
    const child = session?.history.get(handleId)
    if (!session?.open.has(handleId) || child?.token !== token) {
      return
    }
    child.closed = 'stopped'
    session.open.delete(handleId)
    return child.start && { token, start: child.start, phase: 'interrupted' }
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  hasOpen(sessionId: string): boolean {
    return (this.sessions.get(sessionId)?.open.size ?? 0) > 0
  }

  handles(sessionId: string): Iterable<string> | undefined {
    const open = this.sessions.get(sessionId)?.open
    return open && open.size > 0 ? open.keys() : undefined
  }

  private live(
    sessionId: string,
    handleId: string,
    run: string | undefined,
    restart: boolean,
    active: boolean
  ): void {
    const session = this.sessions.get(sessionId) ?? {
      history: new Map<string, ChildLifetime>(),
      open: new Set<string>()
    }
    this.sessions.set(sessionId, session)
    let child = session.history.get(handleId)
    if (!child) {
      child = { run, previous: new Set(), token: newToken(), closed: null }
      session.history.set(handleId, child)
    } else {
      if (run !== undefined && child.previous.has(run)) {
        return
      }
      if (child.run === undefined && run !== undefined) {
        child.run = run
        if (child.closed === 'terminal' || (active && child.closed === 'stopped')) {
          child.token = newToken()
        }
      } else if (run !== undefined && run !== child.run) {
        if (child.run !== undefined) {
          child.previous.add(child.run)
        }
        child.run = run
        child.token = newToken()
      } else if (restart || (active && child.closed === 'stopped')) {
        child.token = newToken()
      } else if (child.closed === 'terminal' && child.run !== undefined) {
        return
      } else if (child.closed === 'terminal') {
        // Runless producers cannot distinguish fresh starts from earlier runs.
        child.token = newToken()
      }
    }
    child.closed = active ? null : 'idle'
    if (active) {
      session.open.add(handleId)
    } else {
      session.open.delete(handleId)
    }
  }

  private end(sessionId: string, handleId: string, run: string | undefined): void {
    const session = this.sessions.get(sessionId)
    const child = session?.history.get(handleId)
    if (!session || !child || (run !== undefined && child.previous.has(run))) {
      return
    }
    // An ending may arrive before any evidence of its start.
    child.closed = 'terminal'
    session.open.delete(handleId)
  }
}
