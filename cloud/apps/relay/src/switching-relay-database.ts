import {
  consumeRelayCellInventoryHold,
  type RelayDatabase,
  type RelayLockOptions,
  type RelayTransactionOptions,
  type SqlRow
} from './database.js'
import type { CellInventoryHoldCounts } from './cell-inventory-hold-samples.js'
import {
  sameDedicatedDatabaseTarget,
  type DatabaseQuiesce,
  type DatabaseTargetPointer,
  type DedicatedDatabaseTarget
} from './relay-database-target-pointer.js'
import type {
  OpenedRelayDatabaseTarget,
  RelayDatabaseTarget,
  RelayDatabaseTargetName
} from './relay-database-targets.js'

const PROBE_TIMEOUT_MS = 3_000
const PROBE_INTERVAL_MS = 250
const BOOT_SELECTION_CAP_MS = 10_000
// A refused login probes the other target at most this often.
const REFUSAL_PROBE_SPACING_MS = 1_000
// The only evidence a fence gives: the target refused the relay's password.
const AUTH_REFUSAL_CODES = new Set(['28P01', '28000'])

type Active = { name: RelayDatabaseTargetName; opened: OpenedRelayDatabaseTarget; generation: number }
type ProbeResult = { generation: number; opened: OpenedRelayDatabaseTarget }
type Choice = Active & { reason: string }
type Hold = { id: string; clear: () => void }

export type SwitchingRelayDatabaseInput = {
  primary: RelayDatabaseTarget & { opened: OpenedRelayDatabaseTarget }
  openDedicated: (target: DedicatedDatabaseTarget) => RelayDatabaseTarget
  // Settles once the first pointer read does; null when absent or unreadable. Never rejects.
  firstPointer: () => Promise<DatabaseTargetPointer | null>
  probeTimeoutMs?: number
  probeIntervalMs?: number
  bootSelectionCapMs?: number
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
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    wake?.(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

// DATABASE_URL (primary) plus the pointer's dedicated instance. One target serves at a time;
// the authority generation each one reports decides which, and only a successful read of a
// higher generation moves it. Losing contact is never evidence: a timeout or reset never switches.
export class SwitchingRelayDatabase implements RelayDatabase {
  readonly dialect = 'postgres' as const
  private active: Active
  private dedicated: { config: DedicatedDatabaseTarget; target: RelayDatabaseTarget } | null = null
  private selection: 'pending' | 'running' | 'without-pointer' | 'done' = 'pending'
  private selecting: Promise<void> | null = null
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

  constructor(private readonly input: SwitchingRelayDatabaseInput) {
    this.active = { name: 'primary', opened: input.primary.opened, generation: 0 }
    this.probeTimeoutMs = input.probeTimeoutMs ?? PROBE_TIMEOUT_MS
    this.probeIntervalMs = input.probeIntervalMs ?? PROBE_INTERVAL_MS
    this.bootSelectionCapMs = input.bootSelectionCapMs ?? BOOT_SELECTION_CAP_MS
  }

  async query(sql: string, params?: unknown[]): Promise<SqlRow[]> {
    return await this.run((database) => database.query(sql, params))
  }

  async queryPriority(sql: string, params?: unknown[]): Promise<SqlRow[]> {
    return await this.run((database) =>
      database.queryPriority ? database.queryPriority(sql, params) : database.query(sql, params)
    )
  }

  async queryLocked(
    sql: string,
    params?: unknown[],
    options?: RelayLockOptions
  ): Promise<SqlRow[]> {
    return await this.run((database) => database.queryLocked(sql, params, options))
  }

  // The whole transaction stays on the pool it started on, even if a switch lands meanwhile.
  async transaction<T>(
    operation: (transaction: RelayDatabase) => Promise<T>,
    options?: RelayTransactionOptions
  ): Promise<T> {
    return await this.run((database) => database.transaction(operation, options))
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

  // Waits like any operation, so a director booting inside a hold migrates the target it lands on.
  async applySchemaToActiveTarget(): Promise<void> {
    const active = await this.acquire()
    await active.opened.applySchema()
  }

  // Resolves once the boot selection has; starts it if nothing has yet.
  async ready(): Promise<void> {
    if (this.selection === 'pending') this.startBootSelection()
    await this.selecting
  }

  applyPointer(pointer: DatabaseTargetPointer | null): void {
    if (!pointer || this.closed) return
    this.adoptDedicated(pointer.dedicated)
    if (this.selection === 'without-pointer') this.startLateSelection()
    this.applyQuiesce(pointer.quiesce)
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

  private async run<T>(operation: (database: RelayDatabase) => Promise<T>): Promise<T> {
    const active = await this.acquire()
    try {
      return await operation(active.opened.database)
    } catch (error) {
      if (isAuthRefusal(error)) this.probeAfterRefusal(active)
      throw error
    }
  }

  private async acquire(): Promise<Active> {
    if (this.selection === 'pending') this.startBootSelection()
    while (this.blockers.size > 0) {
      this.waiters += 1
      try {
        await Promise.all(this.blockers)
      } finally {
        this.waiters -= 1
      }
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
  ): Promise<ProbeResult | null> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([target.probe(timeoutMs).catch(() => null), timedOut])
    } finally {
      clearTimeout(timer)
    }
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

  // An unanswered primary counts as generation 0, so a primary timeout can never hand the
  // process to a dedicated target that was never cut over to.
  private async choose(): Promise<Choice> {
    const dedicated = this.dedicated?.target
    const [primary, other] = await Promise.all([
      this.probe(this.input.primary),
      dedicated ? this.probe(dedicated) : null
    ])
    const primaryGeneration = primary?.generation ?? 0
    if (other && other.generation > primaryGeneration) {
      return { name: 'dedicated', ...other, reason: 'higher-generation' }
    }
    const reason =
      primary === null
        ? other === null
          ? 'none-accepting'
          : 'tie'
        : other === null
          ? 'dedicated-unavailable'
          : other.generation === primaryGeneration
            ? 'tie'
            : 'higher-generation'
    const opened = this.input.primary.opened
    return { name: 'primary', opened, generation: primaryGeneration, reason }
  }

  private adopt(choice: Choice, phase: 'boot' | 'pointer-appeared'): void {
    this.active = { name: choice.name, opened: choice.opened, generation: choice.generation }
    log('orca_relay_database_target_selected', {
      target: choice.name,
      generation: choice.generation,
      reason: choice.reason,
      phase
    })
  }

  private startBootSelection(): void {
    this.selection = 'running'
    const release = this.block()
    let timer: ReturnType<typeof setTimeout> | undefined
    const capped = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.bootSelectionCapMs)
      timer.unref?.()
    })
    const choosing = (async (): Promise<Choice | null> => {
      const pointer = await this.input.firstPointer().catch(() => null)
      if (!pointer || this.closed) return null
      this.adoptDedicated(pointer.dedicated)
      return await this.choose()
    })()
    this.selecting = Promise.race([choosing, capped])
      .then((choice) => {
        if (choice === 'timeout') {
          // A pointer that arrives later still gets a selection; one already read does not.
          this.selection = this.dedicated ? 'done' : 'without-pointer'
          this.adopt({ ...this.active, reason: 'timeout' }, 'boot')
        } else if (choice === null) {
          this.selection = 'without-pointer'
          this.adopt({ ...this.active, reason: 'no-pointer' }, 'boot')
        } else {
          this.selection = 'done'
          this.adopt(choice, 'boot')
        }
      })
      .finally(() => {
        clearTimeout(timer)
        release()
        this.selecting = null
      })
  }

  // The pointer reached a process that booted without it. Nothing waits: work keeps running on
  // primary, and only a higher generation elsewhere moves it.
  private startLateSelection(): void {
    this.selection = 'running'
    this.selecting = this.choose()
      .then((choice) => {
        this.selection = 'done'
        if (!this.closed) this.adopt(choice, 'pointer-appeared')
      })
      .finally(() => {
        this.selecting = null
      })
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
    try {
      if (this.selection === 'pending') this.startBootSelection()
      await this.selecting
      for (;;) {
        const remainingMs = quiesce.until - Date.now()
        if (remainingMs <= 0 || this.closed) break
        const probeStartedAt = Date.now()
        const other = this.otherTarget()
        const result = other
          ? await this.probe(other.target, Math.min(this.probeTimeoutMs, remainingMs))
          : null
        if (other && result && result.generation > this.active.generation && !this.closed) {
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
    }
  }

  private switchTo(to: RelayDatabaseTargetName, result: ProbeResult, startedAt: number): void {
    const from = this.active.name
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
    if (this.refusalProbing || this.hold || this.selection !== 'done' || this.active !== failed) return
    if (Date.now() - this.refusalProbeAt < REFUSAL_PROBE_SPACING_MS) return
    const other = this.otherTarget()
    if (!other) return
    this.refusalProbing = true
    this.refusalProbeAt = Date.now()
    const startedAt = Date.now()
    void this.probe(other.target)
      .then((result) => {
        if (result && this.active === failed && !this.hold && result.generation > failed.generation) {
          this.switchTo(other.name, result, startedAt)
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.refusalProbing = false
      })
  }
}
