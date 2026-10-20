// A paired desktop and a layout-owner server: the server advertises that it takes layout
// intents, serves the layout methods to the desktop but not to phones, and still serves an older
// desktop every session.tabs mutation it sends today.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/runtime-types'
import { LAYOUT_INTENTS_RUNTIME_CAPABILITY } from '../../../../shared/workspace-layout/layout-intents-capability'
import { remoteRuntimeClientCapabilities } from '../../../../shared/remote-runtime-client-capabilities'
import type { RpcRequest, RpcResponse } from '../core'
import type { RpcCallerScope } from '../rpc-caller-scope'

const PAIRED_DESKTOP: RpcCallerScope = { kind: 'runtime-paired', grants: [] }
const PHONE: RpcCallerScope = { kind: 'mobile' }
const LAYOUT_METHODS = ['layout.subscribe', 'layout.unsubscribe', 'layout.apply'] as const

const layoutOwner = vi.hoisted(() => ({ isMain: true }))
vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))

// Fresh modules, so the method registry is built under this switch.
async function switchedBuild(layoutOwnerIsMain: boolean) {
  layoutOwner.isMain = layoutOwnerIsMain
  vi.resetModules()
  const [{ OrcaRuntimeService }, { RpcDispatcher }, { ALL_RPC_METHODS }] = await Promise.all([
    import('../../orca-runtime'),
    import('../dispatcher'),
    import('./index')
  ])
  return { OrcaRuntimeService, RpcDispatcher, ALL_RPC_METHODS }
}

function request(method: string, params?: unknown): RpcRequest {
  return { id: `req-${method}`, authToken: 'unused', method, params }
}

function errorCode(response: RpcResponse): string | null {
  return response.ok ? null : response.error.code
}

afterEach(() => {
  layoutOwner.isMain = true
})

describe('the layout intents capability', () => {
  it('is advertised only by a layout-owner build', async () => {
    const on = await switchedBuild(true)
    expect(new on.OrcaRuntimeService().getStatus().capabilities).toContain(
      LAYOUT_INTENTS_RUNTIME_CAPABILITY
    )
    const off = await switchedBuild(false)
    expect(new off.OrcaRuntimeService().getStatus().capabilities).not.toContain(
      LAYOUT_INTENTS_RUNTIME_CAPABILITY
    )
  })

  it('names only methods a layout-owner build registers', async () => {
    const { ALL_RPC_METHODS } = await switchedBuild(true)
    const registered = new Set(ALL_RPC_METHODS.map((method) => method.name))
    for (const method of LAYOUT_METHODS) {
      expect(registered.has(method), method).toBe(true)
    }
  })
})

describe('layout methods on a layout-owner server', () => {
  it.each(LAYOUT_METHODS)('admits a paired desktop and refuses a phone: %s', async (method) => {
    const { OrcaRuntimeService, RpcDispatcher } = await switchedBuild(true)
    const dispatcher = new RpcDispatcher({ runtime: new OrcaRuntimeService() })
    // Malformed params: admission runs before validation, so a refusal is the scope's.
    const asDesktop = await dispatcher.dispatch(request(method, { bad: 1 }), {
      callerScope: PAIRED_DESKTOP
    })
    const asPhone = await dispatcher.dispatch(request(method, { bad: 1 }), { callerScope: PHONE })
    expect(errorCode(asDesktop)).not.toBe('forbidden')
    expect(errorCode(asDesktop)).not.toBe('method_not_found')
    expect(errorCode(asPhone)).toBe('forbidden')
  })

  it('streams a snapshot to a paired desktop', async () => {
    const { OrcaRuntimeService, RpcDispatcher } = await switchedBuild(true)
    const runtime = new OrcaRuntimeService()
    const dispatcher = new RpcDispatcher({ runtime })
    const frames: { type?: string; subscriptionId?: string }[] = []
    const done = dispatcher.dispatchStreaming(
      request('layout.subscribe'),
      (raw) => {
        const response = JSON.parse(raw) as RpcResponse
        if (!response.ok) {
          throw new Error(response.error.code)
        }
        frames.push(response.result as { type?: string; subscriptionId?: string })
      },
      { callerScope: PAIRED_DESKTOP, connectionId: 'desktop-1', clientKind: 'runtime' }
    )
    await vi.waitFor(() => expect(frames[0]?.type).toBe('snapshot'))

    const unsubscribed = await dispatcher.dispatch(
      request('layout.unsubscribe', { subscriptionId: frames[0]?.subscriptionId }),
      { callerScope: PAIRED_DESKTOP, connectionId: 'desktop-1', clientKind: 'runtime' }
    )
    expect(unsubscribed.ok).toBe(true)
    await done
    expect(frames.at(-1)?.type).toBe('end')
  })
})

describe('an older desktop on a layout-owner server', () => {
  const WT = 'wt-1'
  const SELECTOR = `id:${WT}`
  // What a desktop from before the capability sends with every request.
  const OLDER_DESKTOP = {
    callerScope: PAIRED_DESKTOP,
    clientKind: 'runtime' as const,
    connectionId: 'older-desktop',
    pairedDeviceId: 'older-desktop',
    clientCapabilities: remoteRuntimeClientCapabilities().filter(
      (capability) => capability !== LAYOUT_INTENTS_RUNTIME_CAPABILITY
    )
  }

  function terminalTab(parentTabId: string, isActive: boolean) {
    return {
      type: 'terminal' as const,
      id: `${parentTabId}::leaf-1`,
      parentTabId,
      leafId: 'leaf-1',
      title: 'Terminal',
      status: 'ready' as const,
      terminal: `pty-${parentTabId}`,
      isActive
    }
  }

  function published(): RuntimeMobileSessionTabsSnapshot {
    return {
      worktree: WT,
      publicationEpoch: 'epoch-1',
      snapshotVersion: 1,
      activeGroupId: 'group-a',
      activeTabId: 'tab-a::leaf-1',
      activeTabType: 'terminal',
      tabGroups: [{ id: 'group-a', activeTabId: 'tab-a', tabOrder: ['tab-a', 'tab-b', 'tab-c'] }],
      tabs: [terminalTab('tab-a', true), terminalTab('tab-b', false), terminalTab('tab-c', false)]
    }
  }

  /** A windowless (serve) host: no notifier, its tabs already published. */
  async function headlessServer() {
    const { OrcaRuntimeService, RpcDispatcher } = await switchedBuild(true)
    const runtime = new OrcaRuntimeService()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the published snapshot map is protected; seeding it stands in for a prior publication.
    const snapshots = (
      runtime as unknown as {
        mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
      }
    ).mobileSessionTabsByWorktree
    snapshots.set(WT, published())
    const dispatcher = new RpcDispatcher({ runtime })
    const send = (method: string, params: unknown) =>
      dispatcher.dispatch(request(method, params), OLDER_DESKTOP)
    return { runtime, send, current: () => snapshots.get(WT) }
  }

  // Every session.tabs mutation a desktop sends, and the runtime method that serves it.
  const MUTATIONS = [
    ['session.tabs.activate', 'activateMobileSessionTab', { tabId: 'tab-b' }],
    [
      'session.tabs.move',
      'moveMobileSessionTab',
      {
        kind: 'reorder',
        tabId: 'tab-c',
        targetGroupId: 'group-a',
        tabOrder: ['tab-c', 'tab-a', 'tab-b']
      }
    ],
    [
      'session.tabs.updatePaneLayout',
      'updateMobileSessionPaneLayout',
      { tabId: 'tab-a', root: { type: 'leaf', leafId: 'leaf-1' } }
    ],
    ['session.tabs.setTabProps', 'setMobileSessionTabProps', { tabId: 'tab-b', color: 'red' }],
    ['session.tabs.close', 'closeMobileSessionTab', { tabId: 'tab-c', reason: 'user' }],
    [
      'session.tabs.closeLifecycle',
      'closeMobileSessionTab',
      { tabId: 'tab-c', reason: 'pty-exit', publicationEpoch: 'epoch-1', terminal: 'pty-tab-c' }
    ],
    ['session.tabs.createTerminal', 'createMobileSessionTerminal', {}]
  ] as const

  it.each(MUTATIONS)('still serves %s', async (method, runtimeMethod, params) => {
    const { runtime, send } = await headlessServer()
    vi.spyOn(runtime, 'listMobileSessionTabs').mockResolvedValue(published())
    const served = vi.spyOn(runtime, runtimeMethod).mockResolvedValue(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test reads only that the method was reached; a tab list is the reply every one of them may project.
      published() as never
    )
    const response = await send(method, { worktree: SELECTOR, ...params })
    expect(errorCode(response)).toBeNull()
    expect(served).toHaveBeenCalledTimes(1)
  })

  it('reorders tabs on the windowless path', async () => {
    const { send, current } = await headlessServer()
    const response = await send('session.tabs.move', {
      worktree: SELECTOR,
      kind: 'reorder',
      tabId: 'tab-c',
      targetGroupId: 'group-a',
      tabOrder: ['tab-c', 'tab-a', 'tab-b']
    })
    expect(errorCode(response)).toBeNull()
    expect(current()?.tabGroups[0]?.tabOrder).toEqual(['tab-c', 'tab-a', 'tab-b'])
  })

  it('names a tab on the windowless path', async () => {
    const { send, current } = await headlessServer()
    const response = await send('session.tabs.setTabProps', {
      worktree: SELECTOR,
      tabId: 'tab-b',
      customTitle: 'Build'
    })
    expect(errorCode(response)).toBeNull()
    expect(current()?.tabs.find((tab) => tab.parentTabId === 'tab-b')?.title).toBe('Build')
  })
})
