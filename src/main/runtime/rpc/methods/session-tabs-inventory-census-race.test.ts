import { describe, expect, it, vi } from 'vitest'
import { SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { OrcaRuntimeService } from '../../orca-runtime'
import { subscribeSessionTabsInventory } from './session-tabs-inventory'

const runningBaselineOracle = process.env.ORCA_TEST_BASELINE_SESSION_TABS_CENSUS_ORACLE === '1'

type Inventory = {
  snapshots: RuntimeMobileSessionTabsResult[]
  authoritative: true
  changeSequence: number
}

function deferredInventory(): {
  promise: Promise<Inventory>
  resolve: (inventory: Inventory) => void
} {
  let resolve!: (inventory: Inventory) => void
  return {
    promise: new Promise<Inventory>((settle) => {
      resolve = settle
    }),
    resolve
  }
}

function snapshot(
  snapshotVersion: number,
  tabs: RuntimeMobileSessionTabsResult['tabs'],
  options: { publicationEpoch?: string; removed?: true } = {}
): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'wt-census-race',
    publicationEpoch: options.publicationEpoch ?? 'epoch-current',
    snapshotVersion,
    ...(options.removed ? { removed: true as const } : {}),
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs
  }
}

function terminalTab(id: string): RuntimeMobileSessionTabsResult['tabs'][number] {
  return {
    id,
    type: 'terminal',
    title: id,
    parentTabId: `parent-${id}`,
    leafId: `leaf-${id}`,
    ptyId: `pty-${id}`,
    status: 'ready',
    terminal: `term-${id}`,
    isActive: false
  }
}

type RuntimeInventoryInternals = {
  refreshMobileSessionPtyInventory: () => Promise<PtyInventory>
  sessionTabsStream: { coalescer: { flushAll: () => void } }
  layoutHolder: {
    addCatalogWorkspaces: (keys: string[]) => void
    removeWorkspaces: (keys: string[]) => void
  }
  scheduleMobileSessionTabsChanged: (worktreeId: string) => void
  mobileSessionTabListeners: Set<{
    listener: (result: RuntimeMobileSessionTabsResult, changeSequence: number) => void
  }>
  mobileSessionTabsChangeSequence: number
  emitMobileSessionTabsSnapshotToClient: (
    snapshot: RuntimeMobileSessionTabsResult,
    clientNavigationId: string,
    follow?: boolean
  ) => void
}

type PtyInventory = {
  livePtyIds: Set<string>
  allLivePtyIds: Set<string>
  terminalIdentityByPtyId: Map<string, never>
  queriedHostIds: Set<string>
}

function completePtyInventory(): PtyInventory {
  return {
    livePtyIds: new Set(),
    allLivePtyIds: new Set(),
    terminalIdentityByPtyId: new Map<string, never>(),
    queriedHostIds: new Set(['local'])
  }
}

function deferredPtyInventory(): {
  promise: Promise<PtyInventory>
  resolve: (inventory: PtyInventory) => void
} {
  let resolve!: (inventory: PtyInventory) => void
  return {
    promise: new Promise<PtyInventory>((settle) => {
      resolve = settle
    }),
    resolve
  }
}

/** A real runtime whose phone list is its layout holder; catalog adds and removals publish. */
function createRuntimeHarness(initialWorktrees: string[] = []) {
  const runtime = new OrcaRuntimeService()
  const internals = runtime as unknown as RuntimeInventoryInternals
  const holder = internals.layoutHolder
  holder.addCatalogWorkspaces(initialWorktrees)
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  const census = deferredPtyInventory()
  vi.spyOn(internals, 'refreshMobileSessionPtyInventory').mockReturnValue(census.promise)
  const emit = vi.fn<(event: unknown) => void>()
  const pending = subscribeSessionTabsInventory(
    {
      runtime,
      connectionId: 'conn-runtime-census-race',
      requestId: 'req-runtime-census-race',
      pairedDeviceId: 'paired-runtime-census-race',
      // A client that cannot read structured sessions has no restore ahead of its census, which
      // is the timing these microtask-ordered cases are written against.
      clientKind: 'runtime',
      clientCapabilities: [SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY]
    },
    emit
  )
  const flush = (): void => internals.sessionTabsStream.coalescer.flushAll()
  return {
    census,
    emit,
    flush,
    internals,
    pending,
    /** Holder publishes reach subscribers through the coalescer; `flush: false` leaves them pending. */
    create: (worktree: string, options = { flush: true }): void => {
      holder.addCatalogWorkspaces([worktree])
      if (options.flush) {
        flush()
      }
    },
    /** A coalesced change to what a published worktree shows (a title, a status). */
    change: (worktree: string, options = { flush: true }): void => {
      internals.scheduleMobileSessionTabsChanged(worktree)
      if (options.flush) {
        flush()
      }
    },
    remove: (worktree: string): void => holder.removeWorkspaces([worktree]),
    runtime
  }
}

/** The emitted event's snapshotVersion; a census event reads its first snapshot's. */
function emittedVersion(harness: { emit: ReturnType<typeof vi.fn> }, index: number): number {
  const versionOf = (value: unknown): number => {
    if (typeof value === 'object' && value !== null && 'snapshots' in value) {
      return versionOf(Array.isArray(value.snapshots) ? value.snapshots[0] : undefined)
    }
    const version =
      typeof value === 'object' && value !== null && 'snapshotVersion' in value
        ? value.snapshotVersion
        : undefined
    if (typeof version === 'number') {
      return version
    }
    throw new Error('expected an event carrying a snapshotVersion')
  }
  return versionOf(harness.emit.mock.calls[index]?.[0])
}

function createHarness() {
  const census = deferredInventory()
  const emit = vi.fn<(event: unknown) => void>()
  const unsubscribe = vi.fn<() => void>()
  const cleanup = vi.fn<() => void>()
  let changeSequence = 0
  let listener:
    | ((value: RuntimeMobileSessionTabsResult, changeSequence: number) => void)
    | undefined
  const runtime = {
    supportsAuthoritativeSessionTabsInventory: vi.fn(() => true),
    listAllMobileSessionTabsInventory: vi.fn(() => census.promise),
    listAllMobileSessionTabsInventoryWithChangeSequence: vi.fn(async () => {
      return await census.promise
    }),
    onMobileSessionTabsChanged: vi.fn(
      (nextListener: (value: RuntimeMobileSessionTabsResult, changeSequence: number) => void) => {
        listener = nextListener
        return unsubscribe
      }
    ),
    registerSubscriptionCleanup: vi.fn((_id: string, nextCleanup: () => void) =>
      cleanup.mockImplementation(nextCleanup)
    ),
    cleanupSubscription: vi.fn()
  } as unknown as OrcaRuntimeService

  return {
    census,
    cleanup,
    context: {
      runtime,
      connectionId: 'conn-census-race',
      requestId: 'req-census-race',
      clientCapabilities: [SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY]
    },
    emit,
    deliver: (value: RuntimeMobileSessionTabsResult, sequence: number) =>
      listener?.(value, sequence),
    publish: (value: RuntimeMobileSessionTabsResult) => listener?.(value, ++changeSequence),
    unsubscribe
  }
}

describe.skipIf(runningBaselineOracle)('real runtime session tabs census boundary', () => {
  it('subsumes a delivered change already captured by the census', async () => {
    const harness = createRuntimeHarness()

    harness.create('wt-census-race')
    harness.census.resolve(completePtyInventory())
    await harness.pending

    expect(harness.emit.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        type: 'snapshots',
        authoritative: true,
        snapshots: [expect.objectContaining({ worktree: 'wt-census-race' })]
      })
    ])
  })

  it('subsumes a removal that precedes the final census snapshot', async () => {
    const harness = createRuntimeHarness(['wt-census-race'])

    harness.remove('wt-census-race')
    harness.census.resolve(completePtyInventory())
    await harness.pending

    expect(harness.emit.mock.calls.map(([event]) => event)).toEqual([
      { type: 'snapshots', snapshots: [], authoritative: true }
    ])
  })

  it('subsumes creation and removal at the census release edge', async () => {
    const creation = createRuntimeHarness()
    creation.census.resolve(completePtyInventory())
    creation.create('wt-created')

    const removal = createRuntimeHarness(['wt-removed'])
    removal.census.resolve(completePtyInventory())
    removal.remove('wt-removed')

    await Promise.all([creation.pending, removal.pending])

    expect(creation.emit).toHaveBeenCalledOnce()
    expect(creation.emit.mock.calls[0]?.[0]).toMatchObject({
      type: 'snapshots',
      snapshots: [expect.objectContaining({ worktree: 'wt-created' })]
    })
    expect(removal.emit.mock.calls.map(([event]) => event)).toEqual([
      { type: 'snapshots', snapshots: [], authoritative: true }
    ])
  })

  it('does not replay a delayed pre-boundary change after initialization', async () => {
    const harness = createRuntimeHarness()

    harness.create('wt-census-race', { flush: false })
    harness.census.resolve(completePtyInventory())
    await harness.pending
    harness.flush()

    expect(harness.emit.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        type: 'snapshots',
        authoritative: true,
        snapshots: [expect.objectContaining({ worktree: 'wt-census-race' })]
      })
    ])
  })

  it('delivers a creation after the effective snapshot boundary', async () => {
    const harness = createRuntimeHarness()

    harness.census.resolve(completePtyInventory())
    queueMicrotask(() => harness.create('wt-census-race'))
    await harness.pending

    expect(harness.emit.mock.calls.map(([event]) => event)).toEqual([
      { type: 'snapshots', snapshots: [], authoritative: true },
      expect.objectContaining({ type: 'updated', worktree: 'wt-census-race' })
    ])
  })

  it('delivers a removal after the effective snapshot boundary', async () => {
    const harness = createRuntimeHarness(['wt-census-race'])

    harness.census.resolve(completePtyInventory())
    queueMicrotask(() => harness.remove('wt-census-race'))
    await harness.pending

    expect(harness.emit.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        type: 'snapshots',
        authoritative: true,
        snapshots: [expect.objectContaining({ worktree: 'wt-census-race' })]
      }),
      expect.objectContaining({
        type: 'updated',
        worktree: 'wt-census-race',
        removed: true,
        tabs: []
      })
    ])
  })

  it('coalesces ordinary same-structure churn and replays worktrees in sequence order', async () => {
    const harness = createRuntimeHarness()

    harness.census.resolve(completePtyInventory())
    queueMicrotask(() => {
      harness.create('wt-b')
      harness.create('wt-a')
      harness.change('wt-b')
    })
    await harness.pending

    expect(harness.emit.mock.calls.map(([event]) => event)).toEqual([
      { type: 'snapshots', snapshots: [], authoritative: true },
      expect.objectContaining({ type: 'updated', worktree: 'wt-a' }),
      expect.objectContaining({ type: 'updated', worktree: 'wt-b' })
    ])
    // The replayed wt-b is its latest change, not its creation.
    expect(emittedVersion(harness, 2)).toBeGreaterThan(emittedVersion(harness, 1))
  })

  it('replays create, remove, and recreate transitions without collapsing them', async () => {
    const harness = createRuntimeHarness()

    harness.census.resolve(completePtyInventory())
    queueMicrotask(() => {
      harness.create('wt-census-race')
      harness.remove('wt-census-race')
      harness.create('wt-census-race')
    })
    await harness.pending

    expect(harness.emit.mock.calls.map(([event]) => event)).toEqual([
      { type: 'snapshots', snapshots: [], authoritative: true },
      expect.objectContaining({ type: 'updated', worktree: 'wt-census-race' }),
      expect.objectContaining({ type: 'updated', worktree: 'wt-census-race', removed: true }),
      expect.objectContaining({ type: 'updated', worktree: 'wt-census-race' })
    ])
    expect(emittedVersion(harness, 3)).toBeGreaterThan(emittedVersion(harness, 1))
  })

  it('cancels a stale coalesced callback before removal and later recreation', async () => {
    const harness = createRuntimeHarness(['wt-census-race'])

    harness.census.resolve(completePtyInventory())
    await harness.pending
    harness.change('wt-census-race', { flush: false })
    harness.remove('wt-census-race')
    harness.flush()
    harness.create('wt-census-race')

    expect(harness.emit.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        type: 'snapshots',
        snapshots: [expect.objectContaining({ worktree: 'wt-census-race' })]
      }),
      expect.objectContaining({ type: 'updated', worktree: 'wt-census-race', removed: true }),
      expect.objectContaining({ type: 'updated', worktree: 'wt-census-race' })
    ])
    expect(harness.emit.mock.calls[2]?.[0]).not.toHaveProperty('removed')
  })

  it('keeps a newer immediate change when an older coalesced callback arrives last', async () => {
    const harness = createRuntimeHarness()

    harness.create('wt-census-race', { flush: false })
    harness.census.resolve(completePtyInventory())
    queueMicrotask(() => {
      harness.runtime.notifyMobileSessionTabsChanged('wt-census-race')
      harness.flush()
    })
    await harness.pending

    expect(harness.emit.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        type: 'snapshots',
        snapshots: [expect.objectContaining({ worktree: 'wt-census-race' })]
      }),
      expect.objectContaining({ type: 'updated', worktree: 'wt-census-race' })
    ])
    expect(emittedVersion(harness, 1)).toBeGreaterThan(emittedVersion(harness, 0))
  })

  it('preserves caller-only follow intent when a later shared snapshot is buffered', async () => {
    const runtime = new OrcaRuntimeService()
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const census = deferredInventory()
    vi.spyOn(runtime, 'listAllMobileSessionTabsInventoryWithChangeSequence').mockImplementation(
      () => census.promise
    )
    const callerEmit = vi.fn<(event: unknown) => void>()
    const bystanderEmit = vi.fn<(event: unknown) => void>()
    const callerPending = subscribeSessionTabsInventory(
      {
        runtime,
        connectionId: 'conn-caller',
        requestId: 'req-caller',
        pairedDeviceId: 'device-caller'
      },
      callerEmit
    )
    const bystanderPending = subscribeSessionTabsInventory(
      {
        runtime,
        connectionId: 'conn-bystander',
        requestId: 'req-bystander',
        pairedDeviceId: 'device-bystander'
      },
      bystanderEmit
    )
    const followed = snapshot(1, [terminalTab('followed')])
    const latest = snapshot(2, [terminalTab('latest')])
    const internals = runtime as unknown as RuntimeInventoryInternals

    census.resolve({ snapshots: [], authoritative: true, changeSequence: 0 })
    queueMicrotask(() => {
      internals.emitMobileSessionTabsSnapshotToClient(followed, 'device-caller', true)
      // A shared change every subscriber receives, as the runtime fans one out.
      const changeSequence = ++internals.mobileSessionTabsChangeSequence
      for (const subscription of internals.mobileSessionTabListeners) {
        subscription.listener(latest, changeSequence)
      }
    })
    await Promise.all([callerPending, bystanderPending])

    expect(callerEmit).toHaveBeenCalledTimes(3)
    expect(callerEmit.mock.calls[1]?.[0]).toMatchObject({
      type: 'updated',
      worktree: followed.worktree,
      snapshotVersion: followed.snapshotVersion,
      navigationIntent: 'follow',
      tabs: [expect.objectContaining({ id: 'followed' })]
    })
    expect(callerEmit.mock.calls[2]?.[0]).toMatchObject({
      type: 'updated',
      worktree: latest.worktree,
      snapshotVersion: latest.snapshotVersion,
      tabs: [expect.objectContaining({ id: 'latest' })]
    })
    expect(callerEmit.mock.calls[2]?.[0]).not.toHaveProperty('navigationIntent')
    expect(bystanderEmit).toHaveBeenCalledTimes(2)
    expect(bystanderEmit.mock.calls[1]?.[0]).toMatchObject({
      type: 'updated',
      worktree: latest.worktree,
      snapshotVersion: latest.snapshotVersion,
      tabs: [expect.objectContaining({ id: 'latest' })]
    })
    expect(bystanderEmit.mock.calls[1]?.[0]).not.toHaveProperty('navigationIntent')
  })

  it('subsumes pre-boundary follow intent into the census selection', async () => {
    const runtime = new OrcaRuntimeService()
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const census = deferredInventory()
    vi.spyOn(runtime, 'listAllMobileSessionTabsInventoryWithChangeSequence').mockImplementation(
      () => census.promise
    )
    const emit = vi.fn<(event: unknown) => void>()
    const pending = subscribeSessionTabsInventory(
      {
        runtime,
        connectionId: 'conn-follow-before',
        requestId: 'req-follow-before',
        pairedDeviceId: 'device-follow-before'
      },
      emit
    )
    const selected = snapshot(1, [terminalTab('selected')])
    const internals = runtime as unknown as RuntimeInventoryInternals

    internals.emitMobileSessionTabsSnapshotToClient(selected, 'device-follow-before', true)
    census.resolve({ snapshots: [selected], authoritative: true, changeSequence: 1 })
    await pending

    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: 'snapshots', snapshots: [selected] }
    ])
  })

  it('uses one change sequence across subscribers without duplicate fanout', async () => {
    const runtime = new OrcaRuntimeService()
    const internals = runtime as unknown as RuntimeInventoryInternals
    const first: number[] = []
    const second: number[] = []
    const unsubscribeFirst = runtime.onMobileSessionTabsChanged((_snapshot, sequence) =>
      first.push(sequence)
    )
    const unsubscribeSecond = runtime.onMobileSessionTabsChanged((_snapshot, sequence) =>
      second.push(sequence)
    )

    internals.layoutHolder.addCatalogWorkspaces(['wt-census-race'])
    internals.sessionTabsStream.coalescer.flushAll()

    expect(first).toEqual([expect.any(Number)])
    expect(second).toEqual(first)
    unsubscribeFirst()
    unsubscribeSecond()
  })

  it('aborts the census and removes the real runtime listener on disconnect', async () => {
    const runtime = new OrcaRuntimeService()
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const census = deferredPtyInventory()
    const internals = runtime as unknown as RuntimeInventoryInternals
    vi.spyOn(internals, 'refreshMobileSessionPtyInventory').mockReturnValue(census.promise)
    const controller = new AbortController()
    const pending = subscribeSessionTabsInventory(
      {
        runtime,
        connectionId: 'conn-abort',
        requestId: 'req-abort',
        clientKind: 'runtime',
        signal: controller.signal
      },
      vi.fn()
    )

    controller.abort()
    census.resolve(completePtyInventory())

    await expect(pending).rejects.toThrow('client_disconnected')
    expect(internals.mobileSessionTabListeners).toHaveLength(0)
  })
})

describe('session tabs inventory census boundary', () => {
  it('subsumes a change that precedes the final census snapshot', async () => {
    const harness = createHarness()
    const prior = snapshot(1, [terminalTab('prior')], { publicationEpoch: 'epoch-prior' })
    const current = snapshot(1, [terminalTab('current')])
    const pending = subscribeSessionTabsInventory(harness.context, harness.emit)

    await Promise.resolve()
    harness.publish(prior)
    harness.census.resolve({ snapshots: [current], authoritative: true, changeSequence: 1 })
    await pending

    expect(harness.emit.mock.calls.map(([event]) => event)).toEqual([
      { type: 'snapshots', snapshots: [current], authoritative: true }
    ])
  })

  it('subsumes a creation captured at the census boundary exactly once', async () => {
    const harness = createHarness()
    const created = snapshot(2, [terminalTab('created')])
    const pending = subscribeSessionTabsInventory(harness.context, harness.emit)

    await Promise.resolve()
    harness.publish(created)
    harness.census.resolve({ snapshots: [created], authoritative: true, changeSequence: 1 })
    await pending

    expect(harness.emit.mock.calls.map(([event]) => event)).toEqual([
      { type: 'snapshots', snapshots: [created], authoritative: true }
    ])
  })

  it('delivers a creation after the census boundary as the next ordered update', async () => {
    const harness = createHarness()
    const created = snapshot(2, [terminalTab('created')])
    const pending = subscribeSessionTabsInventory(harness.context, harness.emit)

    await Promise.resolve()
    harness.census.resolve({ snapshots: [], authoritative: true, changeSequence: 0 })
    queueMicrotask(() => harness.publish(created))
    await pending

    expect(harness.emit.mock.calls.map(([event]) => event)).toEqual([
      { type: 'snapshots', snapshots: [], authoritative: true },
      { type: 'updated', ...created }
    ])
  })

  it('delivers a removal after the census boundary as the next ordered update', async () => {
    const harness = createHarness()
    const existing = snapshot(1, [terminalTab('existing')])
    const removed = snapshot(0, [], { publicationEpoch: 'removed:epoch', removed: true })
    const pending = subscribeSessionTabsInventory(harness.context, harness.emit)

    await Promise.resolve()
    harness.census.resolve({ snapshots: [existing], authoritative: true, changeSequence: 0 })
    queueMicrotask(() => harness.publish(removed))
    await pending

    expect(harness.emit.mock.calls.map(([event]) => event)).toEqual([
      { type: 'snapshots', snapshots: [existing], authoritative: true },
      { type: 'updated', ...removed }
    ])
  })

  it('delivers ordinary changes after initialization without duplication', async () => {
    const harness = createHarness()
    const created = snapshot(2, [terminalTab('created')])
    const pending = subscribeSessionTabsInventory(harness.context, harness.emit)

    await Promise.resolve()
    harness.census.resolve({ snapshots: [], authoritative: true, changeSequence: 0 })
    await pending
    harness.publish(created)

    expect(harness.emit.mock.calls.map(([event]) => event)).toEqual([
      { type: 'snapshots', snapshots: [], authoritative: true },
      { type: 'updated', ...created }
    ])
  })

  it('drops a delayed callback already covered by the census watermark', async () => {
    const harness = createHarness()
    const included = snapshot(2, [terminalTab('included')])
    const pending = subscribeSessionTabsInventory(harness.context, harness.emit)

    await Promise.resolve()
    harness.census.resolve({ snapshots: [included], authoritative: true, changeSequence: 1 })
    await pending
    harness.deliver(included, 1)

    expect(harness.emit.mock.calls.map(([event]) => event)).toEqual([
      { type: 'snapshots', snapshots: [included], authoritative: true }
    ])
  })

  it('deduplicates a post-watermark notification already projected by the census', async () => {
    const harness = createHarness()
    const included = snapshot(2, [terminalTab('included')])
    const pending = subscribeSessionTabsInventory(harness.context, harness.emit)

    await Promise.resolve()
    harness.census.resolve({ snapshots: [included], authoritative: true, changeSequence: 0 })
    await pending
    harness.deliver(included, 1)

    expect(harness.emit.mock.calls.map(([event]) => event)).toEqual([
      { type: 'snapshots', snapshots: [included], authoritative: true }
    ])
  })

  it('delivers a post-boundary projected-state change without a new snapshot revision', async () => {
    const harness = createHarness()
    const pendingTab = {
      ...terminalTab('derived'),
      status: 'pending-handle' as const,
      terminal: null
    }
    const initial = snapshot(2, [pendingTab])
    const ready = snapshot(2, [terminalTab('derived')])
    const pending = subscribeSessionTabsInventory(harness.context, harness.emit)

    await Promise.resolve()
    harness.census.resolve({ snapshots: [initial], authoritative: true, changeSequence: 0 })
    await pending
    harness.deliver(ready, 1)

    expect(harness.emit.mock.calls.map(([event]) => event)).toEqual([
      { type: 'snapshots', snapshots: [initial], authoritative: true },
      { type: 'updated', ...ready }
    ])
  })

  it('replays buffered follow intent before the later ordinary snapshot', async () => {
    const harness = createHarness()
    const followed = {
      ...snapshot(1, [terminalTab('followed')]),
      navigationIntent: 'follow' as const
    }
    const latest = snapshot(2, [terminalTab('latest')])
    const pending = subscribeSessionTabsInventory(harness.context, harness.emit)

    await Promise.resolve()
    harness.census.resolve({ snapshots: [], authoritative: true, changeSequence: 0 })
    queueMicrotask(() => {
      harness.publish(followed)
      harness.publish(latest)
    })
    await pending

    expect(harness.emit.mock.calls.map(([event]) => event)).toEqual([
      { type: 'snapshots', snapshots: [], authoritative: true },
      { type: 'updated', ...followed },
      { type: 'updated', ...latest }
    ])
  })

  it('bounds non-structural initialization churn to the latest projected state', async () => {
    const harness = createHarness()
    const pending = subscribeSessionTabsInventory(harness.context, harness.emit)

    await Promise.resolve()
    harness.census.resolve({ snapshots: [], authoritative: true, changeSequence: 0 })
    queueMicrotask(() => {
      for (let version = 1; version <= 1_000; version += 1) {
        harness.publish(snapshot(version, [terminalTab('stable')]))
      }
    })
    await pending

    expect(harness.emit.mock.calls.map(([event]) => event)).toEqual([
      { type: 'snapshots', snapshots: [], authoritative: true },
      { type: 'updated', ...snapshot(1_000, [terminalTab('stable')]) }
    ])
  })

  it('bounds alternating selection churn to the latest projected state', async () => {
    const harness = createHarness()
    const pending = subscribeSessionTabsInventory(harness.context, harness.emit)

    await Promise.resolve()
    harness.census.resolve({ snapshots: [], authoritative: true, changeSequence: 0 })
    queueMicrotask(() => {
      for (let version = 1; version <= 1_000; version += 1) {
        const selected = version % 2 === 0
        harness.publish({
          ...snapshot(version, [{ ...terminalTab('stable'), isActive: selected }]),
          activeTabId: selected ? 'stable' : null,
          activeTabType: selected ? 'terminal' : null
        })
      }
    })
    await pending

    expect(harness.emit).toHaveBeenCalledTimes(2)
    expect(harness.emit.mock.calls[1]?.[0]).toMatchObject({
      type: 'updated',
      snapshotVersion: 1_000,
      activeTabId: 'stable'
    })
  })

  it('bounds repeated follow intent to the latest caller request', async () => {
    const harness = createHarness()
    const pending = subscribeSessionTabsInventory(harness.context, harness.emit)

    await Promise.resolve()
    harness.census.resolve({ snapshots: [], authoritative: true, changeSequence: 0 })
    queueMicrotask(() => {
      for (let version = 1; version <= 1_000; version += 1) {
        harness.publish({
          ...snapshot(version, [terminalTab(`followed-${version}`)]),
          navigationIntent: 'follow'
        })
      }
    })
    await pending

    expect(harness.emit.mock.calls.map(([event]) => event)).toEqual([
      { type: 'snapshots', snapshots: [], authoritative: true },
      {
        type: 'updated',
        ...snapshot(1_000, [terminalTab('followed-1000')]),
        navigationIntent: 'follow'
      }
    ])
  })

  it('restarts the census when structural churn fills the bounded buffer', async () => {
    const firstCensus = deferredInventory()
    const secondCensus = deferredInventory()
    const emit = vi.fn<(event: unknown) => void>()
    let listener:
      | ((value: RuntimeMobileSessionTabsResult, changeSequence: number) => void)
      | undefined
    const collect = vi
      .fn()
      .mockImplementationOnce(() => firstCensus.promise)
      .mockImplementationOnce(() => secondCensus.promise)
    const runtime = {
      supportsAuthoritativeSessionTabsInventory: vi.fn(() => true),
      listAllMobileSessionTabsInventoryWithChangeSequence: collect,
      onMobileSessionTabsChanged: vi.fn(
        (nextListener: (value: RuntimeMobileSessionTabsResult, sequence: number) => void) => {
          listener = nextListener
          return vi.fn()
        }
      ),
      registerSubscriptionCleanup: vi.fn(),
      cleanupSubscription: vi.fn()
    } as unknown as OrcaRuntimeService
    const pending = subscribeSessionTabsInventory(
      {
        runtime,
        connectionId: 'conn-structural-churn',
        requestId: 'req-structural-churn'
      },
      emit
    )

    await Promise.resolve()
    for (let sequence = 1; sequence <= 300; sequence += 1) {
      listener?.(snapshot(sequence, sequence % 2 === 0 ? [terminalTab('stable')] : []), sequence)
    }
    firstCensus.resolve({ snapshots: [], authoritative: true, changeSequence: 0 })
    await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(2))
    const settled = snapshot(300, [terminalTab('stable')])
    secondCensus.resolve({ snapshots: [settled], authoritative: true, changeSequence: 300 })
    await pending

    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: 'snapshots', snapshots: [settled] }
    ])
  })

  it('fails before publication after repeated structural buffer overflow', async () => {
    const censuses = [deferredInventory(), deferredInventory(), deferredInventory()]
    const emit = vi.fn<(event: unknown) => void>()
    const unsubscribe = vi.fn()
    let cleanup = vi.fn()
    let listener:
      | ((value: RuntimeMobileSessionTabsResult, changeSequence: number) => void)
      | undefined
    const collect = vi.fn((..._args: unknown[]) => {
      const census = censuses[collect.mock.calls.length - 1]
      if (!census) {
        throw new Error('unexpected extra census')
      }
      return census.promise
    })
    const runtime = {
      supportsAuthoritativeSessionTabsInventory: vi.fn(() => true),
      listAllMobileSessionTabsInventoryWithChangeSequence: collect,
      onMobileSessionTabsChanged: vi.fn(
        (nextListener: (value: RuntimeMobileSessionTabsResult, sequence: number) => void) => {
          listener = nextListener
          return unsubscribe
        }
      ),
      registerSubscriptionCleanup: vi.fn((_id: string, nextCleanup: () => void) => {
        cleanup = vi.fn(nextCleanup)
      }),
      cleanupSubscription: vi.fn(() => cleanup())
    } as unknown as OrcaRuntimeService
    const pending = subscribeSessionTabsInventory(
      {
        runtime,
        connectionId: 'conn-sustained-structural-churn',
        requestId: 'req-sustained-structural-churn'
      },
      emit
    )
    let changeSequence = 0
    const overflowBuffer = (): void => {
      for (let index = 0; index <= 256; index += 1) {
        changeSequence += 1
        listener?.(
          snapshot(changeSequence, index % 2 === 0 ? [terminalTab('alternating')] : []),
          changeSequence
        )
      }
    }

    await Promise.resolve()
    for (let censusIndex = 0; censusIndex < censuses.length; censusIndex += 1) {
      overflowBuffer()
      censuses[censusIndex]?.resolve({
        snapshots: [],
        authoritative: true,
        changeSequence
      })
      if (censusIndex < censuses.length - 1) {
        await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(censusIndex + 2))
      }
    }

    await expect(pending).rejects.toThrow('session_tabs_inventory_unstable')
    expect(collect).toHaveBeenCalledTimes(3)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(emit).not.toHaveBeenCalled()
  })

  it('drops buffered work and removes the listener when disposed during census', async () => {
    const harness = createHarness()
    const pending = subscribeSessionTabsInventory(harness.context, harness.emit)

    await Promise.resolve()
    harness.cleanup()
    harness.publish(snapshot(2, [terminalTab('late')]))
    harness.census.resolve({ snapshots: [], authoritative: true, changeSequence: 0 })
    await pending

    expect(harness.emit).not.toHaveBeenCalled()
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1)
  })
})
