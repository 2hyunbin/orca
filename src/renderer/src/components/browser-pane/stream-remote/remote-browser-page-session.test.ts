import { describe, expect, it, vi } from 'vitest'
import {
  RemoteBrowserPageSession,
  type RemoteBrowserPageHandle,
  type RemoteBrowserRpcCall
} from './remote-browser-page-session'
import { RemoteBrowserOperationTokens } from './remote-browser-stream-tokens'

const layoutOwner = vi.hoisted(() => ({ isMain: true }))
vi.mock('../../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))

type ListReply = { tabs: { browserPageId: string }[] } | Error | Record<string, never>

function setup(args: { list: ListReply; switchOn?: boolean; onList?: () => void }) {
  layoutOwner.isMain = args.switchOn ?? true
  const identity = { tabId: 'desktop-page-1', environmentId: 'env-1', generationBump: false }
  const tokens = new RemoteBrowserOperationTokens({
    isMounted: () => true,
    isActive: () => true,
    getTabId: () => identity.tabId,
    getEnvironmentId: () => identity.environmentId,
    browserPageExists: () => true
  })
  const calls: { method: string; params: unknown }[] = []
  let stored: RemoteBrowserPageHandle | null = null
  const callRpc = (async (_target: unknown, method: string, params?: unknown) => {
    calls.push({ method, params })
    if (method === 'browser.tabList') {
      args.onList?.()
      if (args.list instanceof Error) {
        throw args.list
      }
      return args.list
    }
    if (method === 'browser.tabCreate') {
      return { browserPageId: 'created-page' }
    }
    return {}
  }) as unknown as RemoteBrowserRpcCall
  const session = new RemoteBrowserPageSession({
    tokens,
    callRpc,
    getWorktreeSelector: () => 'id:wt-1',
    getCurrentUrl: () => 'about:blank',
    readStoredHandle: () => stored,
    // The frame-drawn row's page id was minted here; its browser tab id is the host's page id.
    getHostPageIdCandidates: () => ['desktop-page-1', 'host-page-1'],
    writeStoredHandle: (handle) => {
      stored = handle
    },
    removeStoredHandle: () => {
      stored = null
    },
    applyTabInfo: () => {},
    closeMissingRemotePage: () => {}
  })
  return {
    session,
    tokens,
    calls,
    stored: () => stored,
    ensure: () => session.ensureRemotePage(tokens.createOperationToken()!),
    creates: () => calls.filter((call) => call.method === 'browser.tabCreate').length
  }
}

describe('RemoteBrowserPageSession.ensureRemotePage without a stored handle', () => {
  it('adopts the page the host already runs for this tab instead of creating a second one', async () => {
    const harness = setup({
      list: { tabs: [{ browserPageId: 'other-page' }, { browserPageId: 'host-page-1' }] }
    })

    await expect(harness.ensure()).resolves.toBe('host-page-1')

    expect(harness.creates()).toBe(0)
    expect(harness.tokens.remotePage).toBe('host-page-1')
    expect(harness.stored()).toEqual({ environmentId: 'env-1', remotePageId: 'host-page-1' })
    expect(harness.calls[0]).toEqual({ method: 'browser.tabList', params: { worktree: 'id:wt-1' } })
  })

  it('creates a page when the host has none for this tab', async () => {
    const harness = setup({ list: { tabs: [{ browserPageId: 'other-page' }] } })

    await expect(harness.ensure()).resolves.toBe('created-page')

    expect(harness.creates()).toBe(1)
    expect(harness.stored()).toEqual({ environmentId: 'env-1', remotePageId: 'created-page' })
  })

  it.each([
    ['fails', new Error('Unknown method: browser.tabList')],
    ['answers without a tab list', {}]
  ])('falls back to creating a page when the host lookup %s', async (_label, list) => {
    const harness = setup({ list })

    await expect(harness.ensure()).resolves.toBe('created-page')

    expect(harness.creates()).toBe(1)
  })

  it('adopts nothing when the pane moved on during the lookup', async () => {
    let harness: ReturnType<typeof setup> | null = null
    harness = setup({
      list: { tabs: [{ browserPageId: 'host-page-1' }] },
      onList: () => harness?.tokens.supersedeOperations()
    })

    await expect(harness.ensure()).resolves.toBeNull()

    expect(harness.creates()).toBe(0)
    expect(harness.stored()).toBeNull()
    expect(harness.tokens.remotePage).toBeNull()
  })

  it('keeps creating directly with the layout-owner switch off', async () => {
    const harness = setup({ list: { tabs: [{ browserPageId: 'host-page-1' }] }, switchOn: false })

    await expect(harness.ensure()).resolves.toBe('created-page')

    expect(harness.calls.map((call) => call.method)).toEqual(['browser.tabCreate'])
  })
})
