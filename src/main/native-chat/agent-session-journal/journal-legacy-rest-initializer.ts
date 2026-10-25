import type { JournalLegacyRestCandidate } from './journal-legacy-rest-initializer-dependencies'
import { JournalKeyedHeap } from './journal-keyed-heap'
import { readJournalSessionProjection } from './journal-row-table'
import { JournalLegacyRestWorker } from './journal-legacy-rest-worker'
import { LegacyRestSourceOwner, type LegacyRestDeps } from './journal-legacy-rest-source'
import type { LegacyRestRequest, LegacyRestExecutor } from './journal-legacy-rest-worker-protocol'

type Candidate = {
  key: string
  visible: boolean
  updatedAt: number
  order: number
  orphan: boolean
}

/** Main owns admission and publication; all history and disposable storage run in one worker. */
export class JournalLegacyRestInitializer {
  private readonly control = new Int32Array(new SharedArrayBuffer(8))
  private readonly worker: LegacyRestExecutor
  private readonly sources: LegacyRestSourceOwner
  private readonly pending = new JournalKeyedHeap<Candidate>(
    (a, b) =>
      Number(b.visible) - Number(a.visible) || b.updatedAt - a.updatedAt || a.order - b.order
  )
  private readonly attempted = new Set<string>()
  private readonly cleanup = new Set<string>()
  private discovery?: Iterator<string | JournalLegacyRestCandidate | undefined>
  private discovered = false
  private scratchDiscovered = false
  private order = 0
  private running?: Promise<void>
  private pendingAdvance?: () => boolean
  private stopped = false
  private refused = false
  private faults = 0
  private workerDue = 0
  private mainDue = 0
  private wake?: () => void

  constructor(private readonly deps: LegacyRestDeps) {
    this.sources = new LegacyRestSourceOwner(deps)
    this.worker = new JournalLegacyRestWorker(deps.database, this.control, (ms) => this.charge(ms))
  }

  reconsider(sessionId: string): void {
    Atomics.add(this.control, 1, 1)
    this.measure(() => this.enqueue(sessionId))
  }

  /** Synchronous shared control; an action never waits for a native primitive or retirement. */
  pause(): void {
    this.pendingAdvance = undefined
    Atomics.store(this.control, 0, 1)
    Atomics.add(this.control, 1, 1)
    this.wake?.()
  }

  advance(canWork: () => boolean): Promise<void> | undefined {
    if (this.stopped || this.refused || this.deps.database.readOnly || !canWork()) {
      this.pause()
      return
    }
    Atomics.store(this.control, 0, 0)
    if (this.running) {
      this.pendingAdvance = canWork
    } else {
      this.running = this.run(canWork)
        .catch((error: unknown) => this.deps.failed('', error))
        .finally(() => {
          this.running = undefined
          const pending = this.pendingAdvance
          this.pendingAdvance = undefined
          return pending ? this.advance(pending) : undefined
        })
    }
    return this.running
  }

  async close(): Promise<void> {
    this.stopped = true
    this.pause()
    await this.worker.close()
    await this.running
  }

  private charge(ms: number): void {
    this.mainDue = Math.max(this.mainDue, performance.now()) + ms * 11.5
  }

  private measure<T>(run: () => T): T {
    const start = performance.now()
    try {
      return run()
    } finally {
      this.charge(performance.now() - start)
    }
  }

  private enqueue(id: string, supplied?: JournalLegacyRestCandidate): void {
    const previous = this.pending.get(id)
    const priority =
      supplied && previous && this.deps.priority
        ? this.deps.priority(id)
        : (supplied ?? this.deps.priority?.(id))
    this.pending.update(id, {
      key: id,
      visible: priority?.visible ?? false,
      updatedAt: priority?.updatedAt ?? 0,
      // Discovery owns stable ties; a collided key reads current committed metadata.
      order: supplied ? this.order++ : (previous?.order ?? this.order++),
      orphan: !!this.deps.priority && !priority
    })
  }

  private async wait(): Promise<void> {
    const delay = Math.max(this.mainDue, this.workerDue) - performance.now()
    if (delay <= 0) {
      return
    }
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer)
        this.wake = undefined
        resolve()
      }
      const timer = setTimeout(finish, delay)
      timer.unref?.()
      this.wake = finish
    })
  }

  private next(): Omit<LegacyRestRequest, 'id' | 'generation'> | undefined {
    if (!this.discovered) {
      this.discovery ??= this.deps.candidates()[Symbol.iterator]()
      // Each iterator pull is an existing bounded collect/merge step; finish priority discovery first.
      for (let n = 0; n < 32; n++) {
        const item = this.discovery.next()
        if (item.done) {
          this.discovered = true
          break
        }
        if (item.value !== undefined) {
          if (typeof item.value === 'string') {
            this.enqueue(item.value)
          } else {
            this.enqueue(item.value.id, item.value)
          }
        }
      }
      return undefined
    }
    if (!this.scratchDiscovered) {
      return { mode: 'discover', sessionId: '' }
    }
    const candidate = this.pending.top()
    if (candidate) {
      const sessionId = candidate.key
      const source = this.sources.source(sessionId)
      if (!source || this.attempted.has(source.guard)) {
        this.pending.update(sessionId, undefined)
        const projection = readJournalSessionProjection(this.deps.database.db, sessionId)
        if (
          candidate.orphan ||
          !projection ||
          projection.pair[0] !== null ||
          projection.pair[1] === 0
        ) {
          this.cleanup.add(sessionId)
        }
        return undefined
      }
      if (source.known) {
        this.sources.publishKnown(sessionId, source.guard)
        this.pending.update(sessionId, undefined)
        this.cleanup.add(sessionId)
        return undefined
      }
      return { mode: 'replay', sessionId, source }
    }
    const id = this.cleanup.values().next().value
    return id === undefined ? undefined : { mode: 'cleanup', sessionId: id }
  }

  private async run(canWork: () => boolean): Promise<void> {
    while (!this.stopped && !this.refused && canWork()) {
      await this.wait()
      if (this.stopped || !canWork()) {
        return
      }
      const request = this.measure(() => this.next())
      if (!request) {
        if (
          this.discovered &&
          this.scratchDiscovered &&
          !this.pending.top() &&
          !this.cleanup.size
        ) {
          return
        }
        continue
      }
      const generation = Atomics.load(this.control, 1)
      try {
        const response = await this.worker.grant({ ...request, generation }, canWork)
        this.workerDue = performance.now() + response.occupiedMs / 3
        this.faults = 0
        this.measure(() => {
          if (generation !== Atomics.load(this.control, 1) || this.stopped || !canWork()) {
            return
          }
          const { sessionId, source } = request
          if (response.status === 'failed') {
            if (source) {
              this.attempted.add(source.guard)
              this.pending.update(sessionId, undefined)
            } else if (request.mode === 'cleanup') {
              this.cleanup.delete(sessionId)
            } else {
              this.scratchDiscovered = true
              this.refused = true
            }
            this.deps.failed(sessionId, new Error(response.error ?? 'legacy execution failed'))
          } else if (request.mode === 'discover') {
            this.scratchDiscovered = response.status === 'exhausted'
            if (response.candidate && !this.pending.get(response.candidate)) {
              this.enqueue(response.candidate)
            }
          } else if (request.mode === 'cleanup') {
            if (response.status === 'clean') {
              this.cleanup.delete(sessionId)
            }
          } else if (response.status === 'complete' && source) {
            if (this.sources.source(sessionId)?.guard === source.guard) {
              try {
                if (!this.sources.commit(sessionId, source, response.fact ?? null)) {
                  return
                }
              } catch (error) {
                this.attempted.add(source.guard)
                this.pending.update(sessionId, undefined)
                const saved = readJournalSessionProjection(this.deps.database.db, sessionId)
                if (saved && (saved.pair[0] !== null || saved.pair[1] === 0)) {
                  this.enqueue(sessionId)
                  this.cleanup.add(sessionId)
                }
                this.deps.failed(sessionId, error)
                return
              }
              this.attempted.add(source.guard)
              this.pending.update(sessionId, undefined)
              this.cleanup.add(sessionId)
            }
          }
        })
      } catch (error) {
        if (this.stopped) {
          return
        }
        this.faults++
        try {
          await this.worker.retire()
        } catch (retirementError) {
          this.refused = true
          this.deps.failed(request.sessionId, retirementError)
          return
        }
        this.workerDue = performance.now() + 1000
        if (this.faults >= 2) {
          this.refused = true
          this.deps.failed(request.sessionId, error)
        }
      }
    }
  }
}
