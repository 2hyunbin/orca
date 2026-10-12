import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { WorkspaceLayoutEvent } from '../../../../shared/workspace-layout/workspace-layout-stream-frames'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../core'
import { ALL_RPC_METHODS } from './index'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../../runtime-rpc/runtime-rpc-mobile-method-allowlist'
import { emptyLayoutViewRecord } from '../../../../shared/workspace-layout/workspace-layout-views'

const methods = eraseRpcMethods(ALL_RPC_METHODS)
const subscribe = methods.find((method) => method.name === 'layout.subscribe')
const unsubscribeMethod = methods.find((method) => method.name === 'layout.unsubscribe')
const getRemoteSnapshots = methods.find((method) => method.name === 'layout.getRemoteSnapshots')

function harness() {
  const cleanups = new Map<string, () => void>()
  let publish: (event: WorkspaceLayoutEvent) => void = () => {}
  const unsubscribe = vi.fn()
  const fake = {
    subscribeWorkspaceLayouts: (listener: (event: WorkspaceLayoutEvent) => void) => {
      publish = listener
      return {
        snapshot: [
          { key: 'a', layout: { worktreeId: 'a' } },
          { key: 'b', layout: { worktreeId: 'b' } }
        ],
        unsubscribe
      }
    },
    registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup),
    cleanupSubscription: (id: string) => cleanups.get(id)?.()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler calls only the three runtime methods this fake implements.
  const runtime = fake as unknown as OrcaRuntimeService
  return {
    runtime,
    cleanups,
    unsubscribe,
    publish: (event: WorkspaceLayoutEvent) => publish(event)
  }
}

describe('layout.subscribe', () => {
  it('is advertised as workspace-layout.v1, and closed to phones until the OTA page uses it', () => {
    expect(subscribe && isStreamingMethod(subscribe)).toBe(true)
    expect(new OrcaRuntimeService().getStatus().capabilities).toContain('workspace-layout.v1')
    for (const method of methods) {
      if (method.name.startsWith('layout.') || method.name.startsWith('view.')) {
        expect(MOBILE_RPC_METHOD_ALLOWLIST.has(method.name)).toBe(false)
      }
    }
  })

  it("carries the named view's record on the snapshot and only that view's navigate frames", async () => {
    const { runtime, cleanups } = harness()
    const navigateListeners = new Map<string, (request: unknown) => void>()
    const record = emptyLayoutViewRecord()
    Object.assign(runtime, {
      layoutCommands: {
        views: {
          record: vi.fn(() => record),
          onNavigate: (viewId: string, listener: (request: unknown) => void) => {
            navigateListeners.set(viewId, listener)
            return () => navigateListeners.delete(viewId)
          }
        }
      }
    })
    const emitted: unknown[] = []
    if (!subscribe || !isStreamingMethod(subscribe)) {
      throw new Error('layout.subscribe is not a streaming method')
    }
    const done = subscribe.handler(
      { viewId: 'desktop' },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only runtime and connectionId from its context.
      { runtime, connectionId: 'conn-1' } as RpcContext,
      (event) => emitted.push(event)
    )
    expect(emitted[0]).toMatchObject({ type: 'snapshot', view: record })
    const request = { kind: 'focusTab', workspace: 'a', tabId: 't' }
    navigateListeners.get('desktop')?.(request)
    expect(emitted[1]).toEqual({ type: 'navigate', request })
    runtime.cleanupSubscription([...cleanups.keys()][0]!)
    await done
    expect(navigateListeners.size).toBe(0)
  })

  it("refuses to subscribe as another client's view", async () => {
    const { runtime } = harness()
    if (!subscribe || !isStreamingMethod(subscribe)) {
      throw new Error('layout.subscribe is not a streaming method')
    }
    await expect(
      subscribe.handler(
        { viewId: 'desktop' },
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only runtime, connectionId and pairedDeviceId from its context.
        { runtime, connectionId: 'conn-2', pairedDeviceId: 'phone-1' } as RpcContext,
        () => {}
      )
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('sends the snapshot, then the named workspaces’ changes, and ends on unsubscribe', async () => {
    const { runtime, cleanups, unsubscribe, publish } = harness()
    const emitted: unknown[] = []
    if (!subscribe || !isStreamingMethod(subscribe)) {
      throw new Error('layout.subscribe is not a streaming method')
    }
    const done = subscribe.handler(
      { workspaces: ['b'] },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only runtime and connectionId from its context.
      { runtime, connectionId: 'conn-1' } as RpcContext,
      (event) => emitted.push(event)
    )
    const [cleanupKey] = [...cleanups.keys()]
    expect(emitted).toEqual([
      {
        type: 'snapshot',
        subscriptionId: expect.any(String),
        workspaces: [{ key: 'b', layout: { worktreeId: 'b' } }]
      }
    ])
    publish({ type: 'removed', key: 'a' })
    publish({ type: 'removed', key: 'b' })
    runtime.cleanupSubscription(cleanupKey!)
    await done
    expect(emitted.slice(1)).toEqual([{ type: 'removed', key: 'b' }, { type: 'end' }])
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('ends a subscription only for the connection that opened it', async () => {
    const { runtime, unsubscribe } = harness()
    const emitted: unknown[] = []
    if (!subscribe || !isStreamingMethod(subscribe) || !unsubscribeMethod) {
      throw new Error('layout methods are missing')
    }
    if (isStreamingMethod(unsubscribeMethod)) {
      throw new Error('layout.unsubscribe is not a request method')
    }
    const done = subscribe.handler(
      undefined,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only runtime and connectionId from its context.
      { runtime, connectionId: 'conn-1' } as RpcContext,
      (event) => emitted.push(event)
    )
    const [snapshot] = emitted
    const subscriptionId =
      snapshot && typeof snapshot === 'object' && 'subscriptionId' in snapshot
        ? snapshot.subscriptionId
        : undefined
    expect(subscriptionId).toEqual(expect.any(String))

    await unsubscribeMethod.handler(
      { subscriptionId },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only runtime and connectionId from its context.
      { runtime, connectionId: 'conn-2' } as RpcContext
    )
    expect(unsubscribe).not.toHaveBeenCalled()

    await unsubscribeMethod.handler(
      { subscriptionId },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only runtime and connectionId from its context.
      { runtime, connectionId: 'conn-1' } as RpcContext
    )
    await done
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(emitted.at(-1)).toEqual({ type: 'end' })
  })
})

describe('layout.getRemoteSnapshots', () => {
  it('is served but neither advertised nor open to phones (inert)', () => {
    expect(getRemoteSnapshots?.permission).toBe('workspace')
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('layout.getRemoteSnapshots')).toBe(false)
  })

  it('returns the stored snapshot of each known server', async () => {
    const snapshots = {
      one: { workspaces: { a: { worktree: 'a', tabs: [] } } },
      two: { workspaces: {} }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler calls only getRemoteLayoutSnapshots.
    const runtime = { getRemoteLayoutSnapshots: () => snapshots } as unknown as OrcaRuntimeService
    if (!getRemoteSnapshots || isStreamingMethod(getRemoteSnapshots)) {
      throw new Error('layout.getRemoteSnapshots is not a request method')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only runtime from its context.
    const result = await getRemoteSnapshots.handler(undefined, { runtime } as RpcContext)
    expect(result).toEqual({ snapshots })
  })
})
