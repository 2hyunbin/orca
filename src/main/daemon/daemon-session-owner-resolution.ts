import {
  acquireDaemonOwnerInventory,
  awaitDaemonOwnerInventory,
  indexDaemonOwnerInventory,
  resolveDaemonInventoryOwner,
  resolveDaemonInventoryTerminationOwner,
  selectListedDaemonProcesses,
  type OwnerInventory,
  type PendingOwnerInventory,
  type ProviderInventory
} from './daemon-session-owner-inventory'
import type {
  IPtyProvider,
  PtyProcessInfo,
  PtySpawnOptions,
  PtySpawnResult
} from '../providers/pty-provider-contract'
import { spawnDaemonAttachOnly } from './daemon-session-owner-attach'
import { probeDaemonSessionOwner } from './daemon-session-owner-liveness'
import {
  awaitDaemonWorkWithinCallerDeadline,
  DAEMON_DEFAULT_REQUEST_TIMEOUT_MS
} from './daemon-request-deadline'

export type DaemonSessionOwnerResolution<T extends IPtyProvider> =
  | { kind: 'owner'; provider: T }
  | { kind: 'absent' }
  | { kind: 'unknown' }

const OWNER_RESOLUTION_TIMEOUT_MS = 2_000
const OWNER_INVENTORY_CACHE_MS = 1_000
const FAILED_PROVIDER_COOLDOWN_MS = 1_000

export class DaemonSessionOwnerResolver<T extends IPtyProvider> {
  private inventoryInFlight: PendingOwnerInventory<T> | null = null
  private cachedInventory: { value: OwnerInventory<T>; expiresAt: number } | null = null
  private readonly failedProviderCooldowns = new Map<T, number>()
  private readonly routeIncarnations = new Map<string, string | undefined>()
  private epoch = 0

  private readonly providers: T[]

  constructor(
    providers: readonly T[],
    private readonly routes: Map<string, IPtyProvider>,
    private readonly isProviderProvenGone?: (provider: T, error: unknown) => boolean
  ) {
    this.providers = [...providers]
  }

  // Why no epoch bump on its own: a proven-gone provider lists nothing, so in-flight inventories stay valid.
  private forgetProvider(provider: T): void {
    const index = this.providers.indexOf(provider)
    if (index !== -1) {
      this.providers.splice(index, 1)
    }
    this.failedProviderCooldowns.delete(provider)
    this.forgetRoutesOf(provider)
  }

  private forgetRoutesOf(provider: T): void {
    for (const [sessionId, routed] of this.routes) {
      if (routed === provider) {
        this.removeRoute(sessionId)
      }
    }
  }

  invalidateProvider(provider: T): void {
    this.invalidateInventory()
    this.forgetRoutesOf(provider)
    this.failedProviderCooldowns.clear()
    // Another resolver may already have removed this provider's shared routes.
    for (const sessionId of this.routeIncarnations.keys()) {
      if (!this.routes.has(sessionId)) {
        this.routeIncarnations.delete(sessionId)
      }
    }
  }

  async spawnAttachOnly(opts: PtySpawnOptions & { sessionId: string }): Promise<PtySpawnResult> {
    return spawnDaemonAttachOnly(opts, this.providers, this.routes, this.routeIncarnations, this)
  }

  probe(sessionId: string): Promise<boolean | null> {
    return probeDaemonSessionOwner({
      sessionId,
      providers: this.providers,
      routes: this.routes,
      removeRoute: (id) => this.removeRoute(id),
      inventory: () => this.resolutionInventory(false),
      currentEpoch: () => this.epoch
    })
  }

  async resolve(
    sessionId: string,
    expectedIncarnationId?: string,
    expectedIncarnationIsAuthoritative = false
  ): Promise<DaemonSessionOwnerResolution<T>> {
    const inventory = await this.resolutionInventory()
    if (inventory.epoch !== this.epoch) {
      return { kind: 'unknown' }
    }
    const resolution = resolveDaemonInventoryOwner(
      inventory,
      sessionId,
      this.providers.length > 0,
      (id, provider, incarnationId) => this.setRoute(id, provider, incarnationId),
      expectedIncarnationId,
      expectedIncarnationIsAuthoritative
    )
    if (
      (!inventory.complete || resolution.kind === 'unknown') &&
      this.cachedInventory?.value !== inventory
    ) {
      this.cachedInventory = {
        value: inventory,
        expiresAt: Date.now() + OWNER_INVENTORY_CACHE_MS
      }
    }
    return resolution
  }

  resolveTermination = async (sessionId: string, incarnationId: string) => {
    const routed = this.providers.find((provider) => provider === this.routes.get(sessionId))
    if (routed && this.routeIncarnations.get(sessionId) === incarnationId) {
      return { kind: 'owner' as const, provider: routed }
    }
    // Another session's cached inventory cannot prove this one exited.
    const inventory = await this.resolutionInventory(false)
    if (inventory.epoch !== this.epoch) {
      return { kind: 'unknown' as const }
    }
    return resolveDaemonInventoryTerminationOwner(
      inventory,
      sessionId,
      this.providers.length > 0,
      (id, provider, incarnationId) => this.setRoute(id, provider, incarnationId),
      incarnationId
    )
  }

  async discoverRoutes(): Promise<void> {
    // Explicit discovery supersedes pending observations; ordinary readers share them.
    this.invalidateInventory()
    await this.resolutionInventory(false, true)
    this.failedProviderCooldowns.clear()
    this.cachedInventory = null
  }

  async listProcesses(
    opts?: Parameters<IPtyProvider['listProcesses']>[0]
  ): Promise<PtyProcessInfo[]> {
    const pending = this.acquireInventory({
      deadlineMs: opts?.deadlineMs,
      retryFailedProviders: true
    })
    const inventory = await awaitDaemonOwnerInventory(pending, () => this.epoch, opts?.deadlineMs)
    return selectListedDaemonProcesses(inventory, this.routes, this.routeIncarnations, opts)
  }

  recordRoute(sessionId: string, provider: T, incarnationId?: string): void {
    if (
      incarnationId &&
      this.routes.get(sessionId) === provider &&
      this.routeIncarnations.get(sessionId) === incarnationId
    ) {
      return
    }
    this.invalidateInventory()
    this.setRoute(sessionId, provider, incarnationId)
  }

  getVerifiedRoute(sessionId: string): IPtyProvider | undefined {
    return this.routeIncarnations.has(sessionId) ? this.routes.get(sessionId) : undefined
  }

  private setRoute(sessionId: string, provider: T, incarnationId?: string): void {
    this.routes.set(sessionId, provider)
    this.routeIncarnations.set(sessionId, incarnationId)
  }

  forgetRoute(sessionId: string, provider?: T): void {
    if (provider && this.routes.get(sessionId) !== provider) {
      return
    }
    this.invalidateInventory()
    this.removeRoute(sessionId)
  }

  private removeRoute(sessionId: string): void {
    this.routes.delete(sessionId)
    this.routeIncarnations.delete(sessionId)
  }

  private invalidateInventory(): void {
    this.epoch += 1
    this.inventoryInFlight = null
    this.cachedInventory = null
  }

  private async resolutionInventory(
    allowCached = true,
    replaceEstablishedRoutes = false
  ): Promise<OwnerInventory<T>> {
    if (
      allowCached &&
      this.cachedInventory?.value.epoch === this.epoch &&
      this.cachedInventory.expiresAt > Date.now()
    ) {
      return this.cachedInventory.value
    }
    const pending = this.acquireInventory({ replaceEstablishedRoutes })
    const completed = await awaitDaemonWorkWithinCallerDeadline(
      pending.promise.then(() => {}),
      Date.now() + OWNER_RESOLUTION_TIMEOUT_MS
    )
    return completed
      ? pending.promise
      : this.indexInventory(
          pending.entries,
          pending.epoch,
          replaceEstablishedRoutes,
          this.inventoryInFlight === pending ? this.epoch : -1
        )
  }

  private acquireInventory(opts: {
    deadlineMs?: number
    retryFailedProviders?: boolean
    replaceEstablishedRoutes?: boolean
  }): PendingOwnerInventory<T> {
    if (
      this.inventoryInFlight &&
      (opts.deadlineMs === undefined || opts.deadlineMs <= this.inventoryInFlight.deadlineMs)
    ) {
      return this.inventoryInFlight
    }
    this.cachedInventory = null
    // Shared work keeps the normal RPC budget; each reader bounds its own wait.
    const defaultDeadlineMs = Date.now() + DAEMON_DEFAULT_REQUEST_TIMEOUT_MS
    const deadlineMs = Math.max(opts.deadlineMs ?? defaultDeadlineMs, defaultDeadlineMs)
    const epoch = this.epoch
    const pending = acquireDaemonOwnerInventory({
      providers: this.providers,
      deadlineMs,
      epoch,
      shouldQueryProvider: (provider) => {
        if (
          !opts.retryFailedProviders &&
          (this.failedProviderCooldowns.get(provider) ?? 0) > Date.now()
        ) {
          return false
        }
        this.failedProviderCooldowns.delete(provider)
        return true
      },
      isProviderGone: (provider, error) => {
        if (!this.isProviderProvenGone?.(provider, error)) {
          return false
        }
        this.forgetProvider(provider)
        return true
      },
      providerFailed: (provider) => {
        if (epoch === this.epoch) {
          this.failedProviderCooldowns.set(provider, Date.now() + FAILED_PROVIDER_COOLDOWN_MS)
        }
      },
      index: (inventory) => {
        const currentEpoch = this.inventoryInFlight === inventory ? this.epoch : -1
        if (currentEpoch === epoch) {
          this.cachedInventory = null
        }
        return this.indexInventory(
          inventory.entries,
          epoch,
          opts.replaceEstablishedRoutes,
          currentEpoch
        )
      },
      settled: (inventory) => {
        if (this.inventoryInFlight === inventory) {
          this.inventoryInFlight = null
        }
      }
    })
    this.inventoryInFlight = pending
    return pending
  }

  private indexInventory(
    entries: ProviderInventory<T>[],
    epoch: number,
    replaceEstablishedRoutes = false,
    currentEpoch = this.epoch
  ): OwnerInventory<T> {
    return indexDaemonOwnerInventory(
      entries,
      epoch,
      currentEpoch,
      (id, provider, incarnationId) => this.setRoute(id, provider, incarnationId),
      (id) => this.routeIncarnations.delete(id),
      (id) => {
        const provider = this.routes.get(id)
        return provider ? { provider, incarnationId: this.routeIncarnations.get(id) } : undefined
      },
      replaceEstablishedRoutes
    )
  }
}
