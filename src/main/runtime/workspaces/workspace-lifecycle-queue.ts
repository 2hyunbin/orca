import { randomUUID } from 'node:crypto'
import { ProducerRevision } from '../sidebar-inputs/producer-revision'
import type {
  WorkspaceLifecycleHint,
  WorkspaceLifecycleKind
} from '../../../shared/sidebar-list/workspace-lifecycle-hints'
import type {
  WorkspaceCreation,
  WorkspaceCreationsSnapshot
} from '../../../shared/sidebar-list/workspace-creations'

export const WORKSPACE_DELETED_ERROR = 'workspace_deleted'
// Why `terminal_`: the window's sleep toast reads it as the host-could-not-confirm copy.
export const WORKSPACE_LIFECYCLE_UNCONFIRMED_ERROR = 'terminal_workspace_lifecycle_unconfirmed'

/** `unverifiable`: the execution host never confirmed the outcome, so the queue pauses. */
export type LifecycleOutcome = 'settled' | 'unverifiable'

export type LifecycleCommand<T> = {
  kind: Exclude<WorkspaceLifecycleKind, 'create'>
  /** A command accepted under the same opId answers with that command's reply. */
  opId?: string
  run: () => Promise<T>
  /** Reads a reply; defaults to settled. */
  outcome?: (result: T) => LifecycleOutcome
  /** Whether a thrown error means contact was lost mid-run rather than a definite failure. */
  lostContact?: (error: unknown) => boolean
}

/** Calls `done` once a listing that started after this call has applied. */
export type LifecycleMembership = (done: () => void) => void

export type WorkspaceCreationHandle = {
  /** The workspace is persisted; called before the host announces it. */
  named: (worktreeId: string) => void
  close: () => void
}

type Attempt = { outcome: LifecycleOutcome; value?: unknown; error?: unknown; threw: boolean }

type Entry = {
  kind: WorkspaceLifecycleKind
  opId?: string
  state: 'queued' | 'running'
  /** Null for a create, which runs outside the queue between open and close. */
  command: LifecycleCommand<unknown> | null
  reply: Promise<unknown> | null
  settle: (attempt: Attempt) => void
}

type WorkspaceQueue = {
  entries: Entry[]
  /** The command whose outcome went unconfirmed; it re-runs as the proof. */
  paused: LifecycleCommand<unknown> | null
  /** A finished create or delete, held until a fresh listing shows its membership. */
  settling: number
  draining: boolean
}

type Creation = WorkspaceCreation & { key?: string; entry?: Entry; settling?: boolean }

async function attempt(command: LifecycleCommand<unknown>): Promise<Attempt> {
  try {
    const value = await command.run()
    return { outcome: command.outcome?.(value) ?? 'settled', value, threw: false }
  } catch (error) {
    return {
      outcome: command.lostContact?.(error) ? 'unverifiable' : 'settled',
      error,
      threw: true
    }
  }
}

/**
 * One FIFO queue per host-qualified workspace for create, sleep, wake, close and delete. Commands
 * run one at a time in the order accepted and are never merged. Delete cancels what has not started
 * and waits for what has. An unconfirmed outcome pauses the queue; the next command first re-runs
 * the paused one, and only that host's own answer resumes it. Lives in memory: after a restart
 * nothing is pending and readers show observed state.
 */
export class WorkspaceLifecycleQueue {
  readonly revision = new ProducerRevision()
  private readonly queues = new Map<string, WorkspaceQueue>()
  private readonly creations = new Map<string, Creation>()
  private membership: LifecycleMembership = (done) => done()

  /** Where finished creates and deletes wait to be listed; until set they settle at once. */
  setMembership(membership: LifecycleMembership): void {
    this.membership = membership
  }

  submit<T>(key: string, command: LifecycleCommand<T>): Promise<T> {
    const queue = this.queueFor(key)
    const joined = queue.entries.find(
      (entry) =>
        entry.reply &&
        ((command.opId !== undefined && entry.opId === command.opId) ||
          // A second delete joins the first, as a removal in flight always has.
          (command.kind === 'delete' && entry.kind === 'delete'))
    )
    if (joined?.reply) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an opId names one command, so the joined reply is this command's type; a joined delete shares the delete's reply.
      return joined.reply as Promise<T>
    }
    if (queue.entries.some((entry) => entry.kind === 'delete')) {
      return Promise.reject(new Error(WORKSPACE_DELETED_ERROR))
    }
    if (command.kind === 'delete') {
      this.cancelQueued(queue)
    }
    let settle!: (attempt: Attempt) => void
    const reply = new Promise<unknown>((resolve, reject) => {
      settle = (result) => (result.threw ? reject(result.error) : resolve(result.value))
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: widened only to be stored; run's result is handed back to this command's own caller.
    const stored = command as LifecycleCommand<unknown>
    queue.entries.push({
      kind: command.kind,
      opId: command.opId,
      state: 'queued',
      command: stored,
      reply,
      settle
    })
    this.revision.bump()
    void this.drain(key)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: settled only with this command's run result.
    return reply as Promise<T>
  }

  /** Opened once the project is known; a caller without an id gets one, so a CLI create is listed. */
  openCreate(start: {
    creationId?: string
    repoId: string
    /** The named workspace's queue key; commands sent to it then wait behind the create. */
    keyOf?: (worktreeId: string) => string
  }): WorkspaceCreationHandle {
    const creationId = start.creationId ?? randomUUID()
    const creation: Creation = { repoId: start.repoId }
    this.creations.set(creationId, creation)
    this.revision.bump()
    // Identity, not id: a concurrent retry under the same id owns the entry from then on.
    const owns = (): boolean => this.creations.get(creationId) === creation
    return {
      named: (worktreeId) => {
        if (!owns() || creation.worktreeId === worktreeId) {
          return
        }
        creation.worktreeId = worktreeId
        if (start.keyOf && !creation.key && !creation.settling) {
          creation.key = start.keyOf(worktreeId)
          creation.entry = this.bindCreate(creation.key)
        }
        this.revision.bump()
      },
      close: () => {
        if (!owns() || creation.settling) {
          return
        }
        // The next command may start now; only the creation's hint waits for the listing.
        if (creation.key && creation.entry) {
          this.finishEntry(creation.key, creation.entry)
        }
        const finish = (): void => {
          if (owns()) {
            this.creations.delete(creationId)
          }
          this.revision.bump()
        }
        if (creation.worktreeId === undefined) {
          finish()
          return
        }
        // Why held: the creation shows until a listing shows the workspace, in the same revision.
        creation.settling = true
        this.membership(finish)
      }
    }
  }

  /** The per-workspace hints the feed publishes. */
  hints(): Record<string, WorkspaceLifecycleHint> {
    const hints: Record<string, WorkspaceLifecycleHint> = {}
    for (const [key, queue] of this.queues) {
      const deleting = queue.entries.some((entry) => entry.kind === 'delete')
      const head = queue.entries[0]
      const kind = deleting ? 'delete' : (head?.kind ?? queue.paused?.kind)
      if (kind === undefined) {
        // Only a settling delete is left: it shows until its row leaves the listing.
        if (queue.settling > 0) {
          hints[key] = { kind: 'delete', queuedBehind: 0 }
        }
        continue
      }
      hints[key] = {
        kind,
        queuedBehind: deleting ? 0 : Math.max(0, queue.entries.length - 1),
        ...(queue.paused ? { paused: true as const } : {})
      }
    }
    for (const { key, settling } of this.creations.values()) {
      if (key && settling && !hints[key]) {
        hints[key] = { kind: 'create', queuedBehind: 0 }
      }
    }
    return hints
  }

  /** The creations projection the `creations` readers already read. */
  creationsSnapshot(): WorkspaceCreationsSnapshot {
    const creations: WorkspaceCreationsSnapshot['creations'] = {}
    for (const [creationId, { repoId, worktreeId }] of this.creations) {
      creations[creationId] = worktreeId === undefined ? { repoId } : { repoId, worktreeId }
    }
    return { revision: this.revision.value, creations }
  }

  isPaused(key: string): boolean {
    return this.queues.get(key)?.paused != null
  }

  private queueFor(key: string): WorkspaceQueue {
    let queue = this.queues.get(key)
    if (!queue) {
      queue = { entries: [], paused: null, settling: 0, draining: false }
      this.queues.set(key, queue)
    }
    return queue
  }

  private bindCreate(key: string): Entry {
    const queue = this.queueFor(key)
    const entry: Entry = {
      kind: 'create',
      state: 'running',
      command: null,
      reply: null,
      settle: () => {}
    }
    // Ahead of everything not started: the create is already running.
    const firstQueued = queue.entries.findIndex((queued) => queued.state === 'queued')
    queue.entries.splice(firstQueued === -1 ? queue.entries.length : firstQueued, 0, entry)
    return entry
  }

  private finishEntry(key: string, entry: Entry): void {
    const queue = this.queues.get(key)
    const index = queue?.entries.indexOf(entry) ?? -1
    if (queue && index !== -1) {
      queue.entries.splice(index, 1)
      void this.drain(key)
    }
  }

  private cancelQueued(queue: WorkspaceQueue): void {
    const cancelled = queue.entries.filter((entry) => entry.state === 'queued')
    queue.entries = queue.entries.filter((entry) => entry.state !== 'queued')
    for (const entry of cancelled) {
      entry.settle({ outcome: 'settled', error: new Error(WORKSPACE_DELETED_ERROR), threw: true })
    }
  }

  private async drain(key: string): Promise<void> {
    const queue = this.queues.get(key)
    if (!queue || queue.draining) {
      return
    }
    queue.draining = true
    try {
      for (let head = queue.entries[0]; head; head = queue.entries[0]) {
        if (head.state === 'running' || !head.command) {
          // A create running outside the queue; its close drains again.
          return
        }
        head.state = 'running'
        this.revision.bump()
        const result = await this.runHead(queue, head.command)
        queue.entries.splice(queue.entries.indexOf(head), 1)
        if (
          !result.threw &&
          result.outcome === 'settled' &&
          head.kind === 'delete' &&
          !queue.paused
        ) {
          queue.settling += 1
          this.membership(() => {
            queue.settling -= 1
            this.revision.bump()
            this.forgetIfIdle(key, queue)
          })
        }
        head.settle(result)
        this.revision.bump()
      }
    } finally {
      queue.draining = false
      this.forgetIfIdle(key, queue)
    }
  }

  /** Runs the head command, first re-running a paused one as the proof the queue needs. */
  private async runHead(queue: WorkspaceQueue, command: LifecycleCommand<unknown>) {
    const paused = queue.paused
    if (paused) {
      const proof = await attempt(paused)
      if (proof.outcome === 'settled') {
        queue.paused = null
      }
      // The same command again is the retry: the proof is its answer.
      if (paused.kind === command.kind) {
        return proof
      }
      if (proof.outcome !== 'settled') {
        return {
          outcome: 'unverifiable' as const,
          error: new Error(WORKSPACE_LIFECYCLE_UNCONFIRMED_ERROR),
          threw: true
        }
      }
    }
    const result = await attempt(command)
    if (result.outcome === 'unverifiable') {
      queue.paused = command
    }
    return result
  }

  private forgetIfIdle(key: string, queue: WorkspaceQueue): void {
    if (
      queue.entries.length === 0 &&
      !queue.paused &&
      queue.settling === 0 &&
      !queue.draining &&
      this.queues.get(key) === queue
    ) {
      this.queues.delete(key)
    }
  }
}
