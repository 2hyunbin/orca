import type { IPtyProvider } from '../providers/pty-provider-contract'
import type { OwnerInventory, ProviderInventory } from './daemon-session-owner-inventory'
import { DAEMON_DEFAULT_REQUEST_TIMEOUT_MS } from './daemon-request-deadline'

export type OwnerInventoryReader<T extends IPtyProvider> = {
  pending: PendingOwnerInventory<T>
  fresh: boolean
  snapshot: () => OwnerInventory<T>
  release: () => void
}

export class DaemonOwnerInventoryQueue<T extends IPtyProvider> {
  private active: PendingOwnerInventory<T> | null = null
  private queued: PendingOwnerInventory<T> | null = null

  constructor(
    private readonly providers: readonly T[],
    private readonly opts: {
      currentEpoch: () => number
      nextEpoch: () => number
      shouldQueryProvider: (provider: T, retryFailedProviders: boolean) => boolean
      isProviderGone: (provider: T, error: unknown, epoch: number) => boolean
      providerFailed: (provider: T, epoch: number) => void
      index: (
        pending: PendingOwnerInventory<T>,
        replaceEstablishedRoutes?: boolean
      ) => OwnerInventory<T>
    }
  ) {}

  invalidate(): void {
    this.queued?.cancel()
    this.queued = null
    if (this.active?.queued) {
      this.active.cancel()
    }
  }

  acquire(request: {
    deadlineMs?: number
    fresh: boolean
    retryFailedProviders?: boolean
    replaceEstablishedRoutes?: boolean
  }): OwnerInventoryReader<T> {
    const active = this.active
    if (active?.queued || (active && !request.fresh && active.epoch === this.opts.currentEpoch())) {
      return active.retain(request.deadlineMs, request.retryFailedProviders)
    }
    if (active && this.queued) {
      return this.queued.retain(request.deadlineMs, request.retryFailedProviders)
    }
    const pending = new PendingOwnerInventory(this.providers, {
      deadlineMs: request.deadlineMs,
      shouldQueryProvider: (provider) =>
        this.opts.shouldQueryProvider(provider, pending.retryFailedProviders),
      isProviderGone: (provider, error) => this.opts.isProviderGone(provider, error, pending.epoch),
      providerFailed: (provider) => this.opts.providerFailed(provider, pending.epoch),
      index: (inventory) => this.opts.index(inventory, request.replaceEstablishedRoutes),
      idle: (inventory) => {
        if (this.active === inventory) {
          this.active = this.queued
          this.queued = null
          this.schedule(this.active)
        }
      }
    })
    if (active) {
      this.queued = pending
    } else {
      this.active = pending
      this.schedule(pending)
    }
    return pending.retain(request.deadlineMs, request.retryFailedProviders)
  }

  private schedule(pending: PendingOwnerInventory<T> | null): void {
    if (pending) {
      queueMicrotask(() => pending.start(this.opts.nextEpoch))
    }
  }
}

export class PendingOwnerInventory<T extends IPtyProvider> {
  readonly entries: ProviderInventory<T>[] = []
  private readonly completion = Promise.withResolvers<OwnerInventory<T>>()
  readonly promise = this.completion.promise
  epoch = -1
  retryFailedProviders = false
  private deadlineMs = 0
  private phase: 'queued' | 'running' | 'settled' = 'queued'
  private readonly readers = new Set<{ deadlineMs?: number }>()
  private revision = 0
  private indexed: { revision: number; value: OwnerInventory<T> } | null = null

  constructor(
    private readonly providers: readonly T[],
    private readonly opts: {
      deadlineMs?: number
      shouldQueryProvider: (provider: T) => boolean
      isProviderGone: (provider: T, error: unknown) => boolean
      providerFailed: (provider: T) => void
      index: (pending: PendingOwnerInventory<T>) => OwnerInventory<T>
      idle: (pending: PendingOwnerInventory<T>) => void
    }
  ) {}

  get queued(): boolean {
    return this.phase === 'queued'
  }

  get idle(): boolean {
    return this.phase === 'settled' && this.readers.size === 0
  }

  retain(deadlineMs?: number, retryFailedProviders = false): OwnerInventoryReader<T> {
    if (this.queued && deadlineMs !== undefined) {
      this.opts.deadlineMs = Math.max(this.opts.deadlineMs ?? 0, deadlineMs)
    }
    if (this.queued && retryFailedProviders) {
      this.retryFailedProviders = true
    }
    const reader = { deadlineMs }
    this.readers.add(reader)
    return {
      pending: this,
      fresh: this.queued,
      snapshot: () => this.snapshot(),
      release: () => {
        if (!this.readers.delete(reader)) {
          return
        }
        if (this.idle) {
          this.opts.idle(this)
        }
      }
    }
  }

  start(nextEpoch: () => number): void {
    if (!this.queued) {
      return
    }
    for (const reader of this.readers) {
      if (reader.deadlineMs !== undefined && reader.deadlineMs <= Date.now()) {
        this.readers.delete(reader)
      }
    }
    if (this.readers.size === 0) {
      this.cancel()
      return
    }
    this.phase = 'running'
    this.epoch = nextEpoch()
    this.deadlineMs = Math.max(
      this.opts.deadlineMs ?? 0,
      Date.now() + DAEMON_DEFAULT_REQUEST_TIMEOUT_MS
    )
    this.entries.push(...this.providers.map((provider) => ({ provider, processes: null })))
    void Promise.allSettled(this.entries.map((entry) => this.query(entry))).then((results) => {
      const rejected = results.find((result) => result.status === 'rejected')
      this.settle(rejected ? { error: rejected.reason } : undefined)
    })
  }

  cancel(): void {
    if (!this.queued) {
      return
    }
    this.phase = 'settled'
    this.completion.resolve({ candidatesBySessionId: new Map(), complete: false, epoch: -1 })
    if (this.idle) {
      this.opts.idle(this)
    }
  }

  snapshot(): OwnerInventory<T> {
    if (this.epoch === -1) {
      return { candidatesBySessionId: new Map(), complete: false, epoch: -1 }
    }
    if (this.indexed?.revision !== this.revision) {
      this.indexed = { revision: this.revision, value: this.opts.index(this) }
    }
    return this.indexed.value
  }

  private settle(failure?: { error: unknown }): void {
    this.phase = 'settled'
    try {
      if (failure) {
        this.completion.reject(failure.error)
      } else {
        this.completion.resolve(this.snapshot())
      }
    } catch (error) {
      this.completion.reject(error)
    }
    if (this.idle) {
      this.opts.idle(this)
    }
  }

  private async query(entry: ProviderInventory<T>): Promise<void> {
    const { provider } = entry
    try {
      if (!this.opts.shouldQueryProvider(provider)) {
        return
      }
      entry.processes = await provider.listProcesses({ deadlineMs: this.deadlineMs })
    } catch (error) {
      if (this.opts.isProviderGone(provider, error)) {
        entry.processes = []
      } else {
        this.opts.providerFailed(provider)
        entry.failure = { error }
      }
    } finally {
      this.revision += 1
    }
  }
}
