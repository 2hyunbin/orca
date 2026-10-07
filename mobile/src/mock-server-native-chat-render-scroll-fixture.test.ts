import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-types'
import {
  handleRequest,
  type RpcRequest,
  type RpcResponse
} from '../scripts/mock-server-rpc-handlers'
import {
  getRenderScrollChats,
  renderScrollTranscript
} from '../scripts/mock-server-native-chat-render-scroll-fixture'
import {
  useMobileNativeChatSession,
  type MobileNativeChatSession
} from './session/use-mobile-native-chat-session'
import { useMobileNativeChatStreamingBubble } from './session/use-mobile-native-chat-streaming-bubble'
import { mobileNativeChatStreamPreview } from './session/mobile-native-chat-streaming-gate'
import type { RpcClient } from './transport/rpc-client'
import type { RpcResponse as ClientRpcResponse } from './transport/types'
import { MobileSessionTabsStreamHealth } from './session/mobile-session-tabs-stream-health'

function mockSocket(): WebSocket {
  const socket = Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1 })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock handler only reads these socket states and registers close listeners.
  return socket as WebSocket
}

function paramsRecord(raw: unknown): Record<string, unknown> | undefined {
  return raw && typeof raw === 'object' ? Object.fromEntries(Object.entries(raw)) : undefined
}

function tabsFrom(response: RpcResponse): RuntimeMobileSessionTabsResult {
  const result = response.result
  if (!result || typeof result !== 'object' || !('tabs' in result) || !Array.isArray(result.tabs)) {
    throw new Error('Missing tabs fixture')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: session.tabs.list and subscribe return the typed fixture, checked for its tabs envelope above.
  return result as RuntimeMobileSessionTabsResult
}

describe('opt-in native iPad render/scroll fixture', () => {
  let directory: string
  let controlFile: string
  let ws: WebSocket
  let renderer: ReactTestRenderer | null = null
  let session: MobileNativeChatSession | undefined
  let bubble: string | null = null
  let latestTabs: RuntimeMobileSessionTabsResult | undefined
  let nextId = 0
  const reads: RpcRequest[] = []

  function rpc(method: string, params?: Record<string, unknown>): RpcResponse {
    let response: RpcResponse | undefined
    handleRequest(
      { id: `test-${++nextId}`, method, params },
      (next) => {
        response = next
      },
      ws
    )
    if (!response) {
      throw new Error(`No response for ${method}`)
    }
    return response
  }

  function controls(a: string, b = 'idle'): void {
    writeFileSync(controlFile, JSON.stringify({ a, b }))
  }

  const client: RpcClient = {
    sendRequest: async (method, raw) => {
      const params = paramsRecord(raw)
      reads.push({ id: '', method, params })
      const response = rpc(method, params)
      const result: ClientRpcResponse = response.ok
        ? { id: response.id, ok: true, result: response.result, _meta: response._meta }
        : {
            id: response.id,
            ok: false,
            error: response.error ?? { code: 'mock_failure', message: 'Mock request failed' },
            _meta: response._meta
          }
      return result
    },
    subscribe: (method, raw, onData) => {
      const params = paramsRecord(raw)
      handleRequest(
        { id: `sub-${++nextId}`, method, params },
        (response) => onData(response.result),
        ws
      )
      return () => {
        rpc(method.replace(/subscribe$/, 'unsubscribe'), params)
      }
    },
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }

  function Harness({ chatIndex }: { chatIndex: number }): null {
    const chat = getRenderScrollChats()[chatIndex]!
    session = useMobileNativeChatSession({
      client,
      sourceIdentity: 'mock-host\0mock-workspace',
      agent: 'claude',
      sessionId: chat.sessionId,
      transcriptPath: chat.transcriptPath
    })
    const tab = latestTabs?.tabs.find(
      (entry) => entry.type === 'terminal' && entry.terminal === chat.terminal
    )
    const status = tab?.type === 'terminal' ? tab.agentStatus : undefined
    const working = status?.state === 'working'
    bubble = useMobileNativeChatStreamingBubble(
      session.messages,
      mobileNativeChatStreamPreview(status, working),
      chat.sessionId,
      working
    )
    return null
  }

  async function mount(chatIndex = 0): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness, { chatIndex }))
    })
  }

  async function tick(milliseconds: number, chatIndex = 0): Promise<void> {
    await act(async () => {
      vi.advanceTimersByTime(milliseconds)
      renderer?.update(createElement(Harness, { chatIndex }))
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubEnv('MOCK_NATIVE_CHAT', '1')
    vi.stubEnv('MOCK_NATIVE_CHAT_SCENARIO', 'ipad-render-scroll')
    directory = mkdtempSync(join(tmpdir(), 'orca-ipad-fixture-'))
    controlFile = join(directory, 'reply.json')
    vi.stubEnv('MOCK_NATIVE_CHAT_REPLY_CONTROL_FILE', controlFile)
    ws = mockSocket()
    controls('reset', 'reset')
    latestTabs = tabsFrom(rpc('session.tabs.list', { worktree: 'id:test' }))
    controls('idle')
    latestTabs = tabsFrom(rpc('session.tabs.list', { worktree: 'id:test' }))
    session = undefined
    bubble = null
    reads.length = 0
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    ws.emit('close')
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  })

  it('preserves ordinary terminal and one-chat native defaults without the scenario', () => {
    vi.stubEnv('MOCK_NATIVE_CHAT_SCENARIO', '')
    const native = tabsFrom(rpc('session.tabs.list', { worktree: 'id:test' }))
    expect(native.tabs).toHaveLength(1)
    expect(native.tabs[0]).toMatchObject({
      id: 'chat-tab-1',
      title: 'Claude Code',
      terminal: 'chat-term-1'
    })
    expect(rpc('nativeChat.readSession').result).toEqual({ messages: [], hasMore: false })
    vi.stubEnv('MOCK_NATIVE_CHAT', '0')
    const ordinary = tabsFrom(rpc('session.tabs.list', { worktree: 'id:test' }))
    expect(ordinary.tabs[0]).toMatchObject({ title: 'zsh', terminal: 'term-1' })
  })

  it('publishes distinct switchable tabs with stable snapshots and matching terminal inventory', () => {
    const first = tabsFrom(rpc('session.tabs.list', { worktree: 'id:switch' }))
    expect(first.tabs).toHaveLength(2)
    expect(first.tabs.map((tab) => tab.title)).toEqual(['Claude iPad A', 'Claude iPad B'])
    expect(
      first.tabs.map((tab) =>
        tab.type === 'terminal' ? tab.agentStatus?.providerSession?.id : null
      )
    ).toEqual(['mock-ipad-chat-a', 'mock-ipad-chat-b'])
    expect(tabsFrom(rpc('session.tabs.list', { worktree: 'id:switch' })).snapshotVersion).toBe(
      first.snapshotVersion
    )
    rpc('session.tabs.activate', { worktree: 'id:switch', tabId: first.tabs[1]!.id })
    const second = tabsFrom(rpc('session.tabs.list', { worktree: 'id:switch' }))
    expect(second.activeTabId).toBe(first.tabs[1]!.id)
    expect(second.tabs.map((tab) => tab.isActive)).toEqual([false, true])
    expect(second.snapshotVersion).toBe(first.snapshotVersion + 1)
    expect(rpc('terminal.list', { worktree: 'id:switch' }).result).toMatchObject({
      terminals: [{ handle: 'ipad-chat-term-a' }, { handle: 'ipad-chat-term-b' }]
    })
  })

  it('pages 420 varied tall rows through the real session hook and switches without mixing history', async () => {
    await mount()
    expect(session?.messages).toHaveLength(40)
    expect(session?.messages.at(-1)?.blocks).toEqual([
      { type: 'text', text: expect.stringContaining('[IPAD A LAST 420]') }
    ])
    for (let page = 0; page < 7; page += 1) {
      await act(async () => {
        session?.loadEarlier()
      })
    }
    expect(session?.messages).toHaveLength(420)
    expect(session?.hasMore).toBe(false)
    expect(
      reads
        .filter((read) => read.method === 'nativeChat.readSession')
        .map((read) => read.params?.beforeOffset)
    ).toEqual([380, 320, 260, 200, 140, 80, 20])
    expect(session?.messages[0]?.blocks).toEqual([
      { type: 'text', text: expect.stringContaining('[IPAD A FIRST 001]') }
    ])
    expect(new Set(session?.messages.map((entry) => entry.id)).size).toBe(420)
    const heights =
      session?.messages.map((entry) =>
        entry.blocks[0]?.type === 'text' ? entry.blocks[0].text.length : 0
      ) ?? []
    expect(Math.min(...heights)).toBeGreaterThan(700)
    expect(new Set(heights).size).toBeGreaterThan(10)
    await act(async () => renderer?.update(createElement(Harness, { chatIndex: 1 })))
    expect(session?.messages).toHaveLength(40)
    expect(session?.messages.every((entry) => entry.id.startsWith('ipad-b-'))).toBe(true)
    expect(session?.messages.at(-1)?.blocks).toEqual([
      { type: 'text', text: expect.stringContaining('[IPAD B LAST 420]') }
    ])
  })

  it('grows live status text and replaces the preview with one committed reply through real hooks', async () => {
    const tabStream = new MobileSessionTabsStreamHealth<
      RuntimeMobileSessionTabsResult,
      RuntimeMobileSessionTabsResult['tabs'][number]
    >({
      client,
      scope: 'id:test',
      apply: (result) => ({ accepted: true, effectiveTabs: result.tabs }),
      consumeAccepted: (result) => {
        latestTabs = result
      },
      hasRecoveryNeed: () => false
    })
    const subscription = tabStream.beginSubscription()
    const stopTabs = client.subscribe(
      'session.tabs.subscribe',
      { worktree: 'id:test' },
      subscription.listener
    )
    await mount()
    expect(tabStream.isCertified()).toBe(true)
    for (let page = 0; page < 7; page += 1) {
      await act(async () => {
        session?.loadEarlier()
      })
    }
    controls('stream')
    await tick(1000)
    const firstPreview = bubble
    expect(firstPreview).toContain('[IPAD A STREAM]')
    expect(session?.messages).toHaveLength(421)
    await tick(3000)
    expect(bubble?.startsWith(firstPreview ?? '')).toBe(true)
    expect(bubble?.length).toBeGreaterThan(firstPreview?.length ?? 0)
    expect(latestTabs?.tabs[1]).toMatchObject({ agentStatus: { state: 'done' } })
    const livePreview = bubble
    controls('finish')
    await tick(1000)
    expect(bubble).toBeNull()
    expect(session?.messages).toHaveLength(422)
    const final = session?.messages.at(-1)
    expect(final?.id).toBe('mock-ipad-chat-a-reply-1')
    expect(final?.blocks).toEqual([
      { type: 'text', text: expect.stringContaining('[IPAD A COMMITTED LAST turn=1]') }
    ])
    expect(
      final?.blocks[0]?.type === 'text' && final.blocks[0].text.startsWith(livePreview ?? '')
    ).toBe(true)
    expect(session?.messages[0]?.id).toBe('ipad-a-1')
    await tick(5000)
    expect(session?.messages.filter((entry) => entry.id === final?.id)).toHaveLength(1)
    controls('reset')
    await tick(1000)
    expect(session?.messages).toHaveLength(40)
    expect(session?.hasMore).toBe(true)
    subscription.cancel()
    stopTabs()
    tabStream.dispose()
  })

  it('starts a bounded reply on accepted composer input and settles automatically', async () => {
    await mount(1)
    expect(
      rpc('terminal.send', { terminal: 'ipad-chat-term-b', text: 'Explain the resize\r' }).result
    ).toMatchObject({ send: { handle: 'ipad-chat-term-b', accepted: true } })
    await tick(1000, 1)
    expect(renderScrollTranscript(getRenderScrollChats()[1]!)).toHaveLength(421)
    await tick(24000, 1)
    expect(renderScrollTranscript(getRenderScrollChats()[1]!).at(-1)?.id).toBe(
      'mock-ipad-chat-b-reply-1'
    )
    rpc('terminal.send', { terminal: 'ipad-chat-term-b', text: 'repeat' })
    expect(renderScrollTranscript(getRenderScrollChats()[1]!)).toHaveLength(422)
  })

  it('does not stack pushes on resubscribe and cleans only the named subscription', () => {
    const params = { sessionId: 'mock-ipad-chat-a', subscriptionId: 'one', limit: 40 }
    rpc('nativeChat.subscribe', params)
    rpc('nativeChat.subscribe', params)
    expect(vi.getTimerCount()).toBe(1)
    rpc('nativeChat.subscribe', { ...params, subscriptionId: 'two' })
    expect(vi.getTimerCount()).toBe(2)
    rpc('nativeChat.unsubscribe', params)
    expect(vi.getTimerCount()).toBe(1)
    ws.emit('close')
    expect(vi.getTimerCount()).toBe(0)
  })
})
