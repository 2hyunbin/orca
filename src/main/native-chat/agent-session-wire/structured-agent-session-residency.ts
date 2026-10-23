import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import { structuredAgentSessionConversationClosable } from './structured-agent-session-host-lifetime'
import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'
import { STRUCTURED_AGENT_SESSION_MAX_RESIDENT } from './structured-agent-session-idle-sweep'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'

/** Construction, operation use and reusable idle folds have separate lifetimes. */
export class StructuredAgentSessionResidency {
  private automatic: Promise<void> = Promise.resolve()
  private trimming: Promise<void> | undefined
  private readonly construction = new Map<string, () => void>()
  private readonly idle = new Map<string, true>()
  private readonly cache = new Map<string, { reopenFloor: AgentJournalCursor | null }>()
  private readonly borrows = new Map<string, number>()

  constructor(
    private readonly deps: {
      held: (id: string) => boolean
      eligible: (id: string) => boolean
      close: (id: string) => Promise<boolean>
      report: (error: unknown) => void
      limit: number
    }
  ) {}

  cacheReacquisition = (id: string) => this.cache.get(id)
  opened(id: string): void {
    this.cache.delete(id)
    this.construction.get(id)?.()
    this.released(id)
  }
  active = (id: string): void => {
    this.idle.delete(id)
  }
  closed(id: string, atRest: boolean, reopenFloor: AgentJournalCursor | null): void {
    this.idle.delete(id)
    if (atRest) {
      this.cache.set(id, { reopenFloor })
    } else {
      this.cache.delete(id)
    }
  }

  async read<T>(id: string, task: () => Promise<T>): Promise<T> {
    const release = this.borrow(id)
    try {
      return await task()
    } finally {
      // The lock-free conversation accessor promises its caller one immediate synchronous use.
      setImmediate(release).unref?.()
    }
  }

  borrowed(id: string): boolean {
    return this.borrows.has(id)
  }
  borrow(id: string): () => void {
    this.active(id)
    this.borrows.set(id, (this.borrows.get(id) ?? 0) + 1)
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      const remaining = (this.borrows.get(id) ?? 1) - 1
      if (remaining) {
        this.borrows.set(id, remaining)
      } else {
        this.borrows.delete(id)
      }
      this.released(id)
    }
  }

  released(id: string): void {
    this.idle.delete(id)
    if (!this.borrowed(id) && this.deps.eligible(id)) {
      this.idle.set(id, true)
    }
    if (this.idle.size > this.deps.limit) {
      void this.trim().catch(this.deps.report)
    }
  }

  trim(): Promise<void> {
    if (this.trimming) {
      return this.trimming
    }
    const run = async () => {
      // Only pressure visits victims, once each; a refused retirement remains counted.
      const attempted = new Set<string>()
      for (const id of this.idle.keys()) {
        if (this.idle.size <= this.deps.limit) {
          break
        }
        if (attempted.has(id)) {
          continue
        }
        attempted.add(id)
        if (this.borrowed(id) || !this.deps.eligible(id)) {
          this.idle.delete(id)
          continue
        }
        try {
          if (await this.deps.close(id)) {
            this.idle.delete(id)
          }
        } catch (error) {
          this.deps.report(error)
        } finally {
          this.released(id)
        }
      }
      if (this.idle.size > this.deps.limit) {
        this.deps.report(new Error('idle conversation could not be released'))
      }
    }
    const pending = run().finally(() => {
      this.trimming = undefined
    })
    this.trimming = pending
    return pending
  }

  async run<T>(id: string, task: () => Promise<T>): Promise<T> {
    let finishConstruction = () => {}
    const release = this.borrow(id)
    try {
      if (!this.deps.held(id)) {
        const previous = this.automatic
        const permit = new Promise<void>((resolve) => {
          finishConstruction = resolve
        })
        this.automatic = previous.then(() => permit)
        await previous
        await yieldToEventLoop()
        await this.trim()
        if (!this.deps.held(id) && this.idle.size > this.deps.limit) {
          throw new Error('idle conversation could not be released')
        }
        if (this.deps.held(id)) {
          finishConstruction()
        } else {
          this.construction.set(id, finishConstruction)
        }
      }
      return await task()
    } finally {
      if (this.construction.get(id) === finishConstruction) {
        this.construction.delete(id)
      }
      finishConstruction()
      release()
      // Retention cannot replace a successful action or its original error.
    }
  }
}

export function createStructuredAgentSessionConversationResidency(
  host: {
    context: () => StructuredAgentSessionLifetimeContext
    sessions: StructuredAgentSessionConversations
    busy: (id: string) => boolean
    childWorkOpen: (id: string) => boolean
    deliveryActive: (id: string) => boolean
    serialize: <T>(id: string, task: () => Promise<T>) => Promise<T>
  },
  disposed: () => boolean,
  close: (id: string, atRest: boolean) => Promise<boolean>
): StructuredAgentSessionResidency {
  const eligibility = new WeakMap<object, { version: number; epoch: string; closable: boolean }>()
  const residency = new StructuredAgentSessionResidency({
    limit: host.context().deps.idleSweep?.maxResident ?? STRUCTURED_AGENT_SESSION_MAX_RESIDENT,
    held: (id) => host.sessions.has(id),
    eligible: (id) => {
      const session = host.sessions.get(id)
      if (
        disposed() ||
        !session ||
        session.child ||
        host.busy(id) ||
        host.childWorkOpen(id) ||
        host.deliveryActive(id)
      ) {
        return false
      }
      const version = session.journal.submissionVersion()
      let known = eligibility.get(session.journal)
      if (known?.version !== version || known.epoch !== session.journal.epoch) {
        known = {
          version,
          epoch: session.journal.epoch,
          closable: structuredAgentSessionConversationClosable(session, true)
        }
        eligibility.set(session.journal, known)
      }
      return known.closable
    },
    close: (id) =>
      host.busy(id) || residency.borrowed(id)
        ? Promise.resolve(false)
        : host.serialize(id, () =>
            residency.borrowed(id) || host.childWorkOpen(id) || host.deliveryActive(id)
              ? Promise.resolve(false)
              : close(id, true)
          ),
    report: (error) =>
      host
        .context()
        .deps.logger.warn('releasing idle chat cache failed', { scope: 'resident-cap', error })
  })
  return residency
}
