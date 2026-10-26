import {
  captureTerminalInterfaceSampleCurrentness,
  syncTerminalInterfaceInventory,
  publishTerminalInterfaceObservation
} from './terminal-interface-inventory'
import {
  bindTerminalInterfaceHookOwner,
  TerminalInterfaceHookIngress
} from './terminal-interface-hook-ingress'
import { TerminalInterfaceProbe } from './terminal-interface-probe'
import type {
  TerminalInterfaceOwner,
  TerminalInterfaceDriver,
  Lease,
  Entry,
  HookBinding
} from './terminal-interface-contracts'
export type {
  TerminalInterfaceOwner,
  TerminalInterfaceTarget,
  TerminalInterfaceDriver
} from './terminal-interface-contracts'
import { randomUUID } from 'node:crypto'
import { recognizeAgentProcess } from '../../../shared/agent-process-recognition'
import type { TerminalInterfaceObservation } from '../../../shared/terminal-interface-observation'
import type { TerminalInputKind } from '../../../shared/terminal-input-kind'

/** Execution-host observations live with terminal bindings, independently of turn rows. */
export class TerminalInterfaceAuthority {
  readonly epoch = randomUUID()
  version = 0
  private readonly entries = new Map<string, Entry>()
  private lease: Lease | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private nextTick = 0
  private lastTick = 0
  private readonly probes = new TerminalInterfaceProbe(() => this.schedule(0))
  private readonly hooks = new TerminalInterfaceHookIngress(
    () => this.lease?.driver.inventory() ?? [],
    (paneKey, binding, owner) => this.acceptHook(paneKey, binding, owner)
  )

  attachHookBindings(resolve: (paneKey: string) => HookBinding | null): void {
    this.hooks.attachHookBindings(resolve)
  }
  captureHook(paneKey: string, handle?: string) {
    return this.hooks.captureHook(paneKey, handle)
  }
  captureIngress() {
    return this.hooks.captureIngress()
  }

  install(driver: TerminalInterfaceDriver): () => void {
    this.stop()
    this.hooks.reset()
    const lease: Lease = { driver, controller: new AbortController() }
    this.lease = lease
    this.nextTick = performance.now()
    this.tick(lease)
    return () => {
      if (this.lease === lease) {
        this.stop()
      }
    }
  }

  stop(): void {
    const lease = this.lease
    this.lease = null
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = null
    lease?.controller.abort()
    const changed = [...this.entries.values()].some((entry) => entry.observation)
    this.entries.clear()
    if (changed) {
      this.version += 1
      lease?.driver.changed()
    }
    lease?.driver.dispose?.()
  }

  read(ptyId: string, incarnationId: string): TerminalInterfaceObservation | null {
    this.syncInventory()
    this.schedule()
    const entry = this.entries.get(ptyId)
    return entry?.target.binding.incarnationId === incarnationId ? entry.observation : null
  }

  snapshotEvent() {
    this.syncInventory()
    this.schedule()
    return {
      type: 'terminalInterfaces' as const,
      epoch: this.epoch,
      revision: this.version,
      observations: [...this.entries.values()].flatMap((entry) =>
        entry.observation ? [entry.observation] : []
      )
    }
  }

  snapshot(): TerminalInterfaceObservation[] {
    return this.snapshotEvent().observations
  }

  private acceptHook(paneKey: string, binding: HookBinding, owner: TerminalInterfaceOwner): void {
    this.syncInventory()
    const entry = bindTerminalInterfaceHookOwner(this.entries.values(), paneKey, binding, owner)
    if (!entry) {
      return
    }
    if (entry.qualified) {
      this.publish(entry, 'agent', 'hook')
    }
    this.schedule(0)
  }

  input(ptyId: string, _kind: Exclude<TerminalInputKind, 'query-reply'>): void {
    this.syncInventory()
    const entry = this.entries.get(ptyId)
    if (!entry) {
      return
    }
    entry.input += 1
    entry.discoverUntil = performance.now() + 8000
    entry.shellSince = entry.emptySince = null
    entry.due = 0
    this.schedule(0)
  }

  activity(ptyId: string): void {
    const entry = this.entries.get(ptyId)
    const due = performance.now() + 750
    if (entry && due < entry.due) {
      entry.due = due
      this.schedule(due)
    }
  }

  inventoryChanged(): void {
    this.schedule(0)
  }

  private schedule(due?: number): void {
    const lease = this.lease
    if (!lease) {
      return
    }
    const now = performance.now()
    due = Math.max(now, due ?? this.probes.nextDue(this.entries.values()))
    due = this.lastTick + Math.max(1, Math.ceil((due - this.lastTick) / 250)) * 250
    if (!Number.isFinite(due) || (this.timer && this.nextTick <= due)) {
      return
    }
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.nextTick = due
    this.timer = setTimeout(() => this.tick(lease), Math.max(0, due - now))
    this.timer.unref?.()
  }

  private syncInventory(): void {
    const lease = this.lease
    if (lease && syncTerminalInterfaceInventory(this.entries, lease, this.publish.bind(this))) {
      this.version += 1
      this.lease?.driver.changed()
    }
  }

  private tick(lease: Lease): void {
    if (this.lease !== lease) {
      return
    }
    this.timer = null
    const now = performance.now()
    this.lastTick = this.probes.consumeSlot(this.entries.values(), this.nextTick, now)
    this.syncInventory()
    if (this.lease !== lease) {
      return
    }
    this.probes.sampleDue(
      this.entries.values(),
      now,
      (entry, changed) =>
        this.sample(lease, entry, changed).then(() => {
          if (this.lease === lease && this.entries.get(entry.target.binding.ptyId) === entry) {
            this.schedule(this.probes.nextDue([entry]))
          }
        }),
      (changed) => {
        if (this.lease === lease && changed) {
          lease.driver.changed()
        }
      }
    )
    this.schedule()
  }

  private async sample(lease: Lease, entry: Entry, changed: () => void): Promise<void> {
    entry.pending = true
    const target = entry.target
    const matches = captureTerminalInterfaceSampleCurrentness(this.entries, lease, entry)
    const current = (): boolean => this.lease === lease && matches()
    try {
      const sample = await this.probes.bounded(
        lease,
        this.probes.inspect(
          lease,
          target.binding,
          entry.observation?.state === 'agent' && process.platform !== 'win32'
        )
      )
      if (!current()) {
        return
      }
      const { result, dispatchedAt } = sample ?? { result: null, dispatchedAt: Number.NaN }
      const evidence = result?.terminalInterface
      if (
        !evidence &&
        entry.observation?.state === 'agent' &&
        recognizeAgentProcess(result?.foregroundProcess)
      ) {
        entry.shellSince = entry.emptySince = null
        entry.due = performance.now() + 750
        return
      }
      const age = (evidence?.capturedAgeMs ?? Infinity) + performance.now() - dispatchedAt
      const capturedAt = dispatchedAt - (evidence?.capturedAgeMs ?? Infinity)
      if (
        !result ||
        !evidence ||
        !Number.isFinite(age) ||
        age > 1000 ||
        evidence.capturedAgeMs < 0 ||
        evidence.children === 'unverifiable'
      ) {
        this.unavailable(entry, changed)
        return
      }
      if (capturedAt < entry.discoverUntil - 8000) {
        entry.shellSince = entry.emptySince = null
        entry.due = performance.now() + 250
        return
      }
      entry.qualified = true
      const recognized = recognizeAgentProcess(result.foregroundProcess)
      if (evidence.shellForeground && (entry.actual || evidence.children === 'no-children')) {
        entry.shellSince ??= performance.now()
        if (capturedAt - entry.shellSince > 750) {
          this.publish(
            entry,
            'shell',
            entry.actual ? (entry.owner ? 'hook' : 'process') : 'cold',
            changed
          )
        }
      } else if (recognized && evidence.children === 'children') {
        entry.actual = true
        entry.executionLaunchToken = entry.target.launchToken
        entry.shellSince = entry.emptySince = null
        this.publish(entry, 'agent', 'process', changed)
      } else if (!evidence.shellForeground && evidence.children === 'children') {
        entry.shellSince = null
        this.publish(entry, 'unverifiable', 'process', changed)
      } else {
        this.unavailable(entry, changed)
        return
      }
      if (evidence.children === 'no-children' && entry.owner?.current()) {
        entry.emptySince ??= performance.now()
        if (capturedAt - entry.emptySince > 1500) {
          const owner = entry.owner
          const allowed = await this.probes.bounded(lease, owner.mayRetire())
          if (current() && entry.owner === owner && owner.current() && allowed) {
            owner.retire()
            entry.owner = null
          }
        }
      } else {
        entry.emptySince = null
      }
      // Done does not disarm discovery: an interface can quit much later without another hook.
      entry.due =
        performance.now() +
        (entry.owner?.current() ||
        (entry.actual && entry.observation?.state !== 'shell') ||
        performance.now() < entry.discoverUntil
          ? 750
          : 15000)
    } catch {
      if (current()) {
        this.unavailable(entry, changed)
      }
    } finally {
      entry.pending = false
    }
  }

  private unavailable(entry: Entry, changed: () => void): void {
    entry.shellSince = entry.emptySince = null
    // Failed reads cannot revoke accepted execution facts; cold proof must remain fresh.
    if (entry.qualified && (!entry.observation || entry.observation.basis === 'cold')) {
      this.publish(entry, 'unverifiable', 'process', changed)
    }
    entry.due = performance.now() + 3000
  }

  private publish(
    entry: Entry,
    state: TerminalInterfaceObservation['state'],
    basis: TerminalInterfaceObservation['basis'],
    changed = () => this.lease?.driver.changed()
  ): void {
    publishTerminalInterfaceObservation(this, entry, state, basis, changed)
  }
}
