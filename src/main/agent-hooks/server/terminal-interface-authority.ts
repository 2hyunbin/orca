import {
  sameTerminalInterfaceTarget,
  syncTerminalInterfaceInventory
} from './terminal-interface-inventory'
import { TerminalInterfaceHookIngress } from './terminal-interface-hook-ingress'
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

/** Execution-host observations live with terminal bindings, independently of turn rows. */
export class TerminalInterfaceAuthority {
  readonly epoch = randomUUID()
  version = 0
  private readonly entries = new Map<string, Entry>()
  private lease: Lease | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastTick = 0
  private readonly probes = new TerminalInterfaceProbe()
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
    const lease: Lease = { driver, running: 0, controller: new AbortController() }
    this.lease = lease
    this.lastTick = performance.now()
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
    const hadObservations = [...this.entries.values()].some((entry) => entry.observation)
    this.entries.clear()
    if (hadObservations) {
      this.version += 1
      lease?.driver.changed()
    }
    lease?.driver.dispose?.()
  }

  read(ptyId: string, incarnationId: string): TerminalInterfaceObservation | null {
    this.syncInventory()
    const entry = this.entries.get(ptyId)
    return entry?.target.binding.incarnationId === incarnationId ? entry.observation : null
  }

  snapshotEvent() {
    this.syncInventory()
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
    const entry = [...this.entries.values()].find(
      (candidate) =>
        candidate.target.binding.paneKey === paneKey &&
        candidate.target.local &&
        candidate.target.binding.terminalHandle === binding.terminalHandle &&
        candidate.target.binding.incarnationId === binding.incarnationId &&
        (binding.generation === undefined || candidate.target.generation === binding.generation)
    )
    if (!entry || !owner.current()) {
      return
    }
    entry.owner = owner
    entry.actual = true
    entry.executionLaunchToken = owner.launchToken ?? null
    entry.fence += 1
    entry.shellSince = entry.emptySince = null
    entry.due = 0
    if (entry.qualified) {
      this.publish(entry, 'agent', 'hook')
    }
  }

  input(ptyId: string, _kind: 'driving' | 'launch'): void {
    this.syncInventory()
    const entry = this.entries.get(ptyId)
    if (!entry) {
      return
    }
    entry.input += 1
    entry.discoverUntil = performance.now() + 8000
    entry.shellSince = entry.emptySince = null
    entry.due = 0
  }

  activity(ptyId: string): void {
    const entry = this.entries.get(ptyId)
    if (entry) {
      entry.due = Math.min(entry.due, performance.now() + 750)
    }
  }

  private syncInventory(): void {
    if (
      this.lease &&
      syncTerminalInterfaceInventory(this.entries, this.lease, (entry, state, basis) =>
        this.publish(entry, state, basis)
      )
    ) {
      this.version += 1
      this.lease.driver.changed()
    }
  }

  private tick(lease: Lease): void {
    if (this.lease !== lease) {
      return
    }
    const now = performance.now()
    this.syncInventory()
    if (now - this.lastTick > 5000) {
      for (const entry of this.entries.values()) {
        entry.fence += 1
        entry.shellSince = entry.emptySince = null
      }
    }
    this.lastTick = now
    const due = [...this.entries.values()]
      .filter(
        (entry) => !entry.target.blocked && entry.target.local && !entry.pending && entry.due <= now
      )
      .sort((left, right) => left.due - right.due)
    for (const entry of due.slice(0, Math.max(0, 2 - lease.running))) {
      void this.sample(lease, entry)
    }
    this.timer = setTimeout(() => this.tick(lease), 250)
    this.timer.unref?.()
  }

  private async sample(lease: Lease, entry: Entry): Promise<void> {
    entry.pending = true
    lease.running += 1
    const target = entry.target
    const input = entry.input
    const fence = entry.fence
    const current = (): boolean =>
      this.lease === lease &&
      this.entries.get(target.binding.ptyId) === entry &&
      entry.input === input &&
      entry.fence === fence &&
      !entry.target.blocked &&
      sameTerminalInterfaceTarget(target, entry.target) &&
      lease.driver
        .inventory()
        .some((candidate) => !candidate.blocked && sameTerminalInterfaceTarget(target, candidate))
    try {
      const result = await this.probes.bounded(lease, this.probes.inspect(lease, target.binding))
      if (!current()) {
        return
      }
      const evidence = result?.terminalInterface
      if (
        !result ||
        !evidence ||
        evidence.capturedAgeMs > 1000 ||
        evidence.capturedAgeMs < 0 ||
        evidence.children === 'unverifiable'
      ) {
        this.unavailable(entry)
        return
      }
      entry.qualified = true
      const recognized = recognizeAgentProcess(result.foregroundProcess)
      if (evidence.shellForeground && (entry.actual || evidence.children === 'no-children')) {
        entry.shellSince ??= performance.now()
        if (performance.now() - entry.shellSince > 750) {
          this.publish(entry, 'shell', entry.actual ? (entry.owner ? 'hook' : 'process') : 'cold')
        }
      } else if (recognized && evidence.children === 'children') {
        entry.actual = true
        entry.executionLaunchToken = entry.target.launchToken
        entry.shellSince = entry.emptySince = null
        this.publish(entry, 'agent', 'process')
      } else if (!evidence.shellForeground && evidence.children === 'children') {
        entry.shellSince = null
        this.publish(entry, 'unverifiable', 'process')
      } else {
        this.unavailable(entry)
        return
      }
      if (evidence.children === 'no-children' && entry.owner?.current()) {
        entry.emptySince ??= performance.now()
        if (performance.now() - entry.emptySince > 1500) {
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
        this.unavailable(entry)
      }
    } finally {
      entry.pending = false
      lease.running -= 1
    }
  }

  private unavailable(entry: Entry): void {
    entry.shellSince = entry.emptySince = null
    // Failed reads cannot revoke accepted execution facts; cold proof must remain fresh.
    if (entry.qualified && (!entry.observation || entry.observation.basis === 'cold')) {
      this.publish(entry, 'unverifiable', 'process')
    }
    entry.due = performance.now() + 3000
  }

  private publish(
    entry: Entry,
    state: TerminalInterfaceObservation['state'],
    basis: TerminalInterfaceObservation['basis']
  ): void {
    if (
      entry.observation?.state === state &&
      entry.observation.basis === basis &&
      entry.observation.executionLaunchToken === entry.executionLaunchToken &&
      entry.observation.owner === (entry.owner?.token ?? null)
    ) {
      return
    }
    entry.observation = {
      ...entry.target.binding,
      epoch: this.epoch,
      revision: ++this.version,
      inputRevision: entry.input,
      executionLaunchToken: entry.executionLaunchToken,
      owner: entry.owner?.token ?? null,
      state,
      basis
    }
    this.lease?.driver.changed()
  }
}
