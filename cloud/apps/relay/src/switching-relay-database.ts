import {
  consumeRelayCellInventoryHold,
  isRelayDatabaseNothingRanError,
  type RelayDatabase,
  type RelayLockOptions,
  type RelayTransactionOptions,
  type SqlRow
} from './database.js'
import type { CellInventoryHoldCounts } from './cell-inventory-hold-samples.js'
import { markRelayDatabaseError } from './relay-database-rejection-fence.js'
import {
  sameDedicatedDatabaseTarget,
  type DatabaseQuiesce,
  type DatabaseTargetPointer,
  type DedicatedDatabaseTarget
} from './relay-database-target-pointer.js'
import type {
  OpenedRelayDatabaseTarget,
  RelayDatabaseProbeResult,
  RelayDatabaseTarget,
  RelayDatabaseTargetName
} from './relay-database-targets.js'

const PROBE_TIMEOUT_MS = 3_000
const PROBE_INTERVAL_MS = 250
const BOOT_SELECTION_CAP_MS = 10_000
// Residual: a pointer read slower than this at boot starts the process on primary; a fenced
// primary then refuses it, and the refusal (or the pointer, once read) re-selects.
const FIRST_POINTER_WAIT_MS = 2_000
// With no eligible target and a pointer generation above 0, operations fail fast meanwhile.
const UNAVAILABLE_REPROBE_MS = 1_000
// A refused login probes the other target at most this often.
const REFUSAL_PROBE_SPACING_MS = 1_000
// Bounds the re-runs of an operation that failed before any statement ran.
const NOTHING_RAN_RETRIES = 3
// The only evidence a fence gives: the target refused the relay's password.
const AUTH_REFUSAL_CODES = new Set(['28P01', '28000'])

// `generation` is null until the target has answered: unknown is never read as 0.
type Active = {
  name: RelayDatabaseTargetName
  opened: OpenedRelayDatabaseTarget
  generation: number | null
}
type Choice = Active & { reason: string }
type Hold = { id: string; clear: () => void }
type Phase = 'boot' | 'pointer-appeared' | 'refused' | 'below-pointer-generation' | 'reprobe'

export type SwitchingRelayDatabaseInput = {
  primary: RelayDatabaseTarget & { opened: OpenedRelayDatabaseTarget }
  openDedicated: (target: DedicatedDatabaseTarget) => RelayDatabaseTarget
  // Reads the pointer once more and settles with it; null when absent or unreadable. Never rejects.
  firstPointer: () => Promise<DatabaseTargetPointer | null>
  probeTimeoutMs?: number
  probeIntervalMs?: number
  bootSelectionCapMs?: number
  firstPointerWaitMs?: number
  unavailableReprobeMs?: number
}

// 57P03 is transient everywhere the relay classifies errors, so routes answer 503.
export class RelayDatabaseTargetUnavailableError extends Error {
  readonly code = '57P03'
  constructor() {
    super('relay_database_no_eligible_target')
  }
}

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }))
}

function isAuthRefusal(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    AUTH_REFUSAL_CODES.has(String(error.code))
  )
}

function sleep(ms: number, wake?: (resolve: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms))
    timer.unref?.()
    wake?.(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function within<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), Math.max(0, timeoutMs))
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

// DATABASE_URL (primary) plus the pointer's dedicated instance. One target serves at a time;
// the authority generation each one reports decides which. Rules:
// - never serve from a target known to be below the pointer's generation, or not known at all
//   once that generation is above 0;
// - only a successful read of a higher generation moves a serving process: a timeout, reset or
//   silence never does, and an unanswered target's generation is unknown, not 0.
export class SwitchingRelayDatabase implements RelayDatabase {
  readonly dialect = 'postgres' as const
  private active: Active
  private pointer: DatabaseTargetPointer | null = null
  private dedicated: { config: DedicatedDatabaseTarget; target: RelayDatabaseTarget } | null = null
  private booted = false
  private bootDeadline = 0
  private bootWithoutPointer = false
  private selecting: Promise<void> | null = null
  private unavailable = false
  private reprobing = false
  private readonly blockers = new Set<Promise<void>>()
  private readonly releases = new Set<() => void>()
  private waiters = 0
  private hold: Hold | null = null
  private pendingQuiesce: { id: string; timer: ReturnType<typeof setTimeout> } | null = null
  private readonly handledQuiesce = new Set<string>()
  private refusalProbeAt = 0
  private refusalProbing = false
  private closed = false
  private readonly probeTimeoutMs: number
  private readonly probeIntervalMs: number
  private readonly bootSelectionCapMs: number
  private readonly firstPointerWaitMs: number
  private readonly unavailableReprobeMs: number

  constructor(private readonly input: SwitchingRelayDatabaseInput) {
    this.active = { name: 'primary', opened: input.primary.opened, generation: null }
    this.probeTimeoutMs = input.probeTimeoutMs ?? PROBE_TIMEOUT_MS
    this.probeIntervalMs = input.probeIntervalMs ?? PROBE_INTERVAL_MS
    this.bootSelectionCapMs = input.bootSelectionCapMs ?? BOOT_SELECTION_CAP_MS
    this.firstPointerWaitMs = input.firstPointerWaitMs ?? FIRST_POINTER_WAIT_MS
    this.unavailableReprobeMs = input.unavailableReprobeMs ?? UNAVAILABLE_REPROBE_MS
  }

  async query(sql: string, params?: unknown[]): Promise<SqlRow[]> {
    return await this.run(({ opened }) => opened.database.query(sql, params))
  }

  async queryPriority(sql: string, params?: unknown[]): Promise<SqlRow[]> {
    return await this.run(({ opened: { database } }) =>
      database.queryPriority ? database.queryPriority(sql, params) : database.query(sql, params)
    )
  }

  async queryLocked(
    sql: string,
    params?: unknown[],
    options?: RelayLockOptions
  ): Promise<SqlRow[]> {
    return await this.run(({ opened }) => opened.database.queryLocked(sql, params, options))
  }

  // The whole transaction stays on the pool it started on, even if a switch lands meanwhile.
  async transaction<T>(
    operation: (transaction: RelayDatabase) => Promise<T>,
    options?: RelayTransactionOptions
  ): Promise<T> {
    return await this.run(({ opened }) => opened.database.transaction(operation, options))
  }

  activeRelayDatabase(): RelayDatabase {
    return this.active.opened.database
  }

  activeTargetName(): RelayDatabaseTargetName {
    return this.active.name
  }

  consumeHoldCounts(): CellInventoryHoldCounts {
    return consumeRelayCellInventoryHold(this.active.opened.database)
  }

  // Runs like any operation: it waits out a hold, and a refusal at boot re-selects.
  async applySchemaToActiveTarget(): Promise<void> {
    await this.run(async ({ opened }) => await opened.applySchema())
  }

  // Resolves once the boot selection has; starts it if nothing has yet.
  async ready(): Promise<void> {
    if (!this.booted) this.startBoot()
    await this.selecting
  }

  applyPointer(pointer: DatabaseTargetPointer | null): void {
    if (!pointer || this.closed) return
    this.pointer = pointer
    this.adoptDedicated(pointer.dedicated)
    if (this.bootWithoutPointer) {
      this.bootWithoutPointer = false
      if (this.floor() === 0) this.checkLatePointer()
    }
    this.applyQuiesce(pointer.quiesce)
    this.ensureEligible()
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.pendingQuiesce) clearTimeout(this.pendingQuiesce.timer)
    this.hold?.clear()
    for (const release of [...this.releases]) release()
    await Promise.all([
      this.input.primary.close().catch(() => undefined),
      this.dedicated?.target.close().catch(() => undefined)
    ])
  }

  private floor(): number {
    return this.pointer?.generation ?? 0
  }

  // Answered, and at or above the pointer's generation.
  private eligible(result: RelayDatabaseProbeResult | null): result is RelayDatabaseProbeResult {
    return result !== null && result.generation >= this.floor()
  }

  // A serving process moves only onto an eligible target above what its own target last
  // answered (unknown counts as 0 here: the floor still applies).
  private mayMoveTo(result: RelayDatabaseProbeResult): boolean {
    return this.eligible(result) && result.generation > (this.active.generation ?? 0)
  }

  private async run<T>(operation: (active: Active) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const used = await this.acquire()
      try {
        return await operation(used)
      } catch (error) {
        if (attempt < NOTHING_RAN_RETRIES && isRelayDatabaseNothingRanError(error)) {
          // Inside a window, or after a switch: wait for (or use) the post-switch target.
          if (this.hold !== null || this.active.name !== used.name) continue
          if (isAuthRefusal(error) && this.pointer !== null && Date.now() < this.bootDeadline) {
            await this.reselect(this.bootDeadline, 'refused')
            continue
          }
        }
        if (isAuthRefusal(error)) this.probeAfterRefusal(used)
        throw error
      }
    }
  }

  private async acquire(): Promise<Active> {
    if (!this.booted) this.startBoot()
    while (this.blockers.size > 0) {
      this.waiters += 1
      try {
        await Promise.all(this.blockers)
      } finally {
        this.waiters -= 1
      }
    }
    if (this.unavailable) {
      const error = new RelayDatabaseTargetUnavailableError()
      markRelayDatabaseError(error)
      throw error
    }
    return this.active
  }

  private block(): () => void {
    let resolve!: () => void
    const blocker = new Promise<void>((done) => (resolve = done))
    const release = (): void => {
      this.blockers.delete(blocker)
      this.releases.delete(release)
      resolve()
    }
    this.blockers.add(blocker)
    this.releases.add(release)
    return release
  }

  private async probe(
    target: RelayDatabaseTarget,
    timeoutMs = this.probeTimeoutMs
  ): Promise<RelayDatabaseProbeResult | null> {
    return await within(target.probe(timeoutMs).catch(() => null), timeoutMs, null)
  }

  private otherTarget(): { name: RelayDatabaseTargetName; target: RelayDatabaseTarget } | null {
    if (this.active.name === 'dedicated') return { name: 'primary', target: this.input.primary }
    return this.dedicated ? { name: 'dedicated', target: this.dedicated.target } : null
  }

  private adoptDedicated(config: DedicatedDatabaseTarget): void {
    if (this.dedicated && sameDedicatedDatabaseTarget(this.dedicated.config, config)) return
    if (this.active.name === 'dedicated') {
      // Its pool is serving; only a restart may re-point a serving target.
      console.warn(JSON.stringify({ event: 'orca_relay_database_target_change_ignored' }))
      return
    }
    const previous = this.dedicated
    this.dedicated = { config, target: this.input.openDedicated(config) }
    void previous?.target.close().catch(() => undefined)
  }

  // One round over both targets. Eligible: answered, at or above the pointer's generation.
  // A tie goes to primary; so does dedicated at 0 while primary is unknown, since it was
  // never cut over to.
  private async chooseOnce(timeoutMs = this.probeTimeoutMs): Promise<Choice | null> {
    const dedicated = this.dedicated?.target
    const [primary, other] = await Promise.all([
      this.probe(this.input.primary, timeoutMs),
      dedicated ? this.probe(dedicated, timeoutMs) : null
    ])
    // No authority table on primary: no move is in progress (the state after the tool's finish),
    // so primary serves whatever floor a since-deleted pointer left behind.
    if (primary && !primary.moveBegun) {
      return { name: 'primary', opened: primary.opened, generation: 0, reason: 'no-move' }
    }
    if (this.eligible(other) && other.generation > (primary?.generation ?? 0)) {
      return { name: 'dedicated', ...other, reason: 'higher-generation' }
    }
    if (!this.eligible(primary)) return null
    const reason =
      other === null
        ? 'dedicated-unavailable'
        : other.generation === primary.generation
          ? 'tie'
          : 'higher-generation'
    return { name: 'primary', opened: primary.opened, generation: primary.generation, reason }
  }

  private adopt(choice: Choice, phase: Phase): void {
    this.unavailable = false
    this.active = { name: choice.name, opened: choice.opened, generation: choice.generation }
    log('orca_relay_database_target_selected', {
      target: choice.name,
      generation: choice.generation,
      reason: choice.reason,
      phase
    })
  }

  // Holds operations while it runs; one selection at a time.
  private runSelection(body: () => Promise<void>): Promise<void> {
    if (this.selecting) return this.selecting
    const release = this.block()
    let settle!: () => void
    // Set before the body starts: a pointer applied synchronously inside it must see it.
    const selecting = new Promise<void>((resolve) => (settle = resolve))
    this.selecting = selecting
    void body()
      .catch(() => undefined)
      .finally(() => {
        release()
        this.selecting = null
        settle()
      })
    return selecting
  }

  private startBoot(): void {
    this.booted = true
    this.bootDeadline = Date.now() + this.bootSelectionCapMs
    void this.runSelection(async () => {
      const pointer =
        this.pointer ??
        (await within(
          this.input.firstPointer().catch(() => null),
          this.firstPointerWaitMs,
          null
        )) ??
        this.pointer
      if (!pointer || this.closed) {
        this.bootWithoutPointer = true
        await this.serveWithoutPointer('boot')
        return
      }
      if (!this.pointer) this.applyPointer(pointer)
      await this.selectUntil(this.bootDeadline, 'boot')
    }).catch(() => undefined)
  }

  private async reselect(deadline: number, phase: Phase): Promise<void> {
    await this.runSelection(async () => await this.selectUntil(deadline, phase))
  }

  // Probes every interval until an eligible target answers or the deadline passes. Past it,
  // primary only if the pointer's generation is 0; otherwise fail fast and keep probing.
  private async selectUntil(deadline: number, phase: Phase): Promise<void> {
    for (;;) {
      const remainingMs = deadline - Date.now()
      const timeoutMs = Math.max(1, Math.min(this.probeTimeoutMs, remainingMs))
      const choice = await this.chooseOnce(timeoutMs)
      if (this.closed) return
      if (choice) {
        this.adopt(choice, phase)
        return
      }
      if (Date.now() >= deadline) break
      await sleep(Math.min(this.probeIntervalMs, deadline - Date.now()))
    }
    if (this.floor() === 0) {
      const opened = this.input.primary.opened
      this.adopt({ name: 'primary', opened, generation: null, reason: 'none-eligible' }, phase)
      return
    }
    this.becomeUnavailable(phase)
  }

  // With no pointer read, primary serves exactly as before the pointer existed only while it has
  // no authority table. Once a move has begun there, serving needs the pointer: a guess could
  // write to a reopened old copy while the fleet writes to the other one.
  private async serveWithoutPointer(phase: Phase): Promise<boolean> {
    const primary = await this.probe(this.input.primary)
    if (this.closed) return false
    if (!primary || primary.moveBegun) {
      const reason = primary ? 'move-begun' : 'primary-unanswered'
      if (!this.unavailable) log('orca_relay_database_pointer_required', { phase, reason })
      this.becomeUnavailable(phase)
      return false
    }
    const opened = this.input.primary.opened
    this.adopt({ name: 'primary', opened, generation: 0, reason: 'no-pointer' }, phase)
    return true
  }

  private becomeUnavailable(phase: Phase): void {
    if (!this.unavailable) {
      log('orca_relay_database_target_unavailable', { floor: this.floor(), phase })
    }
    this.unavailable = true
    this.startReprobe()
  }


  private startReprobe(): void {
    if (this.reprobing) return
    this.reprobing = true
    void (async () => {
      while (this.unavailable && !this.closed) {
        await sleep(this.unavailableReprobeMs)
        if (this.selecting || this.hold) continue
        if (!this.pointer) {
          await within(this.input.firstPointer().catch(() => null), this.firstPointerWaitMs, null)
        }
        if (this.selecting || this.hold || !this.unavailable || this.closed) continue
        if (!this.pointer) {
          await this.serveWithoutPointer('reprobe')
          continue
        }
        const choice = await this.chooseOnce()
        if (choice && this.unavailable && !this.closed) this.adopt(choice, 'reprobe')
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        this.reprobing = false
      })
  }

  // The serving target must be known to be at or above the pointer's generation.
  private ensureEligible(): void {
    if (!this.booted || this.selecting || this.hold || this.unavailable || this.closed) return
    const floor = this.floor()
    if (floor === 0) return
    if (this.active.generation !== null && this.active.generation >= floor) return
    void this.reselect(Date.now() + this.bootSelectionCapMs, 'below-pointer-generation').catch(
      () => undefined
    )
  }

  // A pointer at generation 0 reached a process that booted without it. Nothing waits: work
  // keeps running on primary, and only a higher generation elsewhere moves it.
  private checkLatePointer(): void {
    const dedicated = this.dedicated?.target
    if (!dedicated) return
    void this.probe(dedicated)
      .then((result) => {
        if (this.closed || this.selecting || this.hold || this.active.name !== 'primary') return
        if (result && this.mayMoveTo(result)) {
          const choice = { name: 'dedicated' as const, ...result, reason: 'higher-generation' }
          this.adopt(choice, 'pointer-appeared')
        }
      })
      .catch(() => undefined)
  }

  private applyQuiesce(quiesce: DatabaseQuiesce | undefined): void {
    // A pointer without this window (or with another) ends it early.
    if (this.hold && this.hold.id !== quiesce?.id) this.hold.clear()
    if (this.pendingQuiesce && this.pendingQuiesce.id !== quiesce?.id) {
      clearTimeout(this.pendingQuiesce.timer)
      this.pendingQuiesce = null
    }
    if (!quiesce || this.handledQuiesce.has(quiesce.id) || this.pendingQuiesce) return
    if (Date.now() >= quiesce.until) {
      this.handledQuiesce.add(quiesce.id)
      return
    }
    const timer = setTimeout(
      () => {
        this.pendingQuiesce = null
        void this.runHold(quiesce).catch(() => undefined)
      },
      Math.max(0, quiesce.startsAt - Date.now())
    )
    timer.unref?.()
    this.pendingQuiesce = { id: quiesce.id, timer }
  }

  private async runHold(quiesce: DatabaseQuiesce): Promise<void> {
    if (this.closed) return
    this.handledQuiesce.add(quiesce.id)
    const release = this.block()
    const startedAt = Date.now()
    // Written by clear(), which runs outside this loop.
    const cleared: { at: number | null; wake: (() => void) | null } = { at: null, wake: null }
    const hold: Hold = {
      id: quiesce.id,
      clear: () => {
        cleared.at ??= Date.now()
        cleared.wake?.()
      }
    }
    this.hold = hold
    log('orca_relay_database_quiesce_started', { id: quiesce.id })
    let session: { close: () => void } | null = null
    try {
      if (!this.booted) this.startBoot()
      await this.selecting
      const other = this.otherTarget()
      // One session held open through the window: the tool checks every marked process
      // reached the target before it fences the source.
      const probes = other ? other.target.probeSession() : null
      session = probes
      for (;;) {
        const remainingMs = quiesce.until - Date.now()
        if (remainingMs <= 0 || this.closed) break
        const probeStartedAt = Date.now()
        const result = probes
          ? await within(
              probes.probe(Math.min(this.probeTimeoutMs, remainingMs)).catch(() => null),
              Math.min(this.probeTimeoutMs, remainingMs),
              null
            )
          : null
        if (other && result && this.mayMoveTo(result) && !this.closed) {
          this.switchTo(other.name, result, startedAt)
          return
        }
        // The tool writes the new generation before it clears the window, so one probe that
        // started after the clear is enough to see it.
        if (cleared.at !== null && probeStartedAt >= cleared.at) break
        if (cleared.at !== null) continue
        await sleep(Math.min(this.probeIntervalMs, quiesce.until - Date.now()), (resolve) => {
          cleared.wake = resolve
        })
        cleared.wake = null
      }
      log('orca_relay_database_quiesce_expired', {
        id: quiesce.id,
        heldMs: Date.now() - startedAt,
        ...(cleared.at === null ? {} : { cleared: true })
      })
    } finally {
      if (this.hold === hold) this.hold = null
      release()
      const held = session
      if (held && cleared.at === null && Date.now() < quiesce.until && !this.closed) {
        const timer = setTimeout(() => held.close(), quiesce.until - Date.now())
        timer.unref?.()
      } else {
        held?.close()
      }
      this.ensureEligible()
    }
  }

  private switchTo(
    to: RelayDatabaseTargetName,
    result: RelayDatabaseProbeResult,
    startedAt: number
  ): void {
    const from = this.active.name
    this.unavailable = false
    this.active = { name: to, opened: result.opened, generation: result.generation }
    log('orca_relay_database_switched', {
      from,
      to,
      generation: result.generation,
      heldMs: Date.now() - startedAt,
      waiters: this.waiters
    })
  }

  // A process that missed the window (the pointer unreadable through it) is left on a fenced
  // target. Its refusal is evidence, and the same rule applies: only a higher generation moves it.
  private probeAfterRefusal(failed: Active): void {
    if (this.refusalProbing || this.hold || this.selecting || this.active !== failed) return
    if (Date.now() - this.refusalProbeAt < REFUSAL_PROBE_SPACING_MS) return
    const other = this.otherTarget()
    if (!other) return
    this.refusalProbing = true
    this.refusalProbeAt = Date.now()
    const startedAt = Date.now()
    void this.probe(other.target)
      .then((result) => {
        if (result && this.active === failed && !this.hold && this.mayMoveTo(result)) {
          this.switchTo(other.name, result, startedAt)
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.refusalProbing = false
      })
  }
}
