// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

// Separate transports per owner make host changes observable.
const { transportFactory, getMockTransport, resetMockTransports } = vi.hoisted(() => {
  type MockTransport = {
    readSession: ReturnType<typeof vi.fn>
    subscribe: ReturnType<typeof vi.fn>
    unsubscribe: ReturnType<typeof vi.fn>
    emit: (frame: unknown) => void
  }
  const transports = new Map<string | null, MockTransport>()
  // Disable autoSnapshot for an unflushed transcript with a silent resolve poll; only readSession can settle it (#8401).
  const getMockTransport = (
    ownerId: string | null,
    opts?: { autoSnapshot?: boolean }
  ): MockTransport => {
    let transport = transports.get(ownerId)
    if (!transport) {
      const unsubscribe = vi.fn()
      let listener: (frame: unknown) => void = () => {}
      transport = {
        unsubscribe,
        readSession: vi.fn().mockResolvedValue({ messages: [] }),
        subscribe: vi.fn((_args, onFrame) => {
          listener = onFrame
          if (opts?.autoSnapshot !== false) {
            onFrame({ type: 'snapshot', messages: [], hasMore: false })
          }
          return unsubscribe
        }),
        emit: (frame) => listener(frame)
      }
      transports.set(ownerId, transport)
    }
    return transport
  }
  return {
    getMockTransport,
    resetMockTransports: () => transports.clear(),
    transportFactory: vi.fn((ownerId: string | null) => getMockTransport(ownerId))
  }
})

vi.mock('../../src/renderer/src/components/native-chat/native-chat-session-transport', () => ({
  getNativeChatSessionTransport: transportFactory
}))

import {
  useNativeChatLiveSession,
  type NativeChatLiveSession,
  type UseNativeChatLiveSessionArgs
} from '../../src/renderer/src/components/native-chat/use-native-chat-live-session'

describe('useNativeChatLiveSession — file watcher pagination composition', () => {
  const AGENT = 'claude' as const
  const SESSION = 'sess-1'
  const PANE = 'pane-1'
  const roots: Root[] = []
  let latest: NativeChatLiveSession | null = null

  function Probe(props: UseNativeChatLiveSessionArgs): null {
    latest = useNativeChatLiveSession(props)
    return null
  }

  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  async function render(props: UseNativeChatLiveSessionArgs): Promise<Root> {
    const container = document.createElement('div')
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(createElement(Probe, props))
    })
    await flush()
    return root
  }

  beforeEach(() => {
    useAppStore.setState({ agentStatusByPaneKey: {} })
  })

  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => root.unmount())
    }
    latest = null
    vi.clearAllMocks()
    resetMockTransports()
  })

  it('keeps the original watcher append after a real 300-to-500 loadEarlier', async () => {
    const { mkdtemp, writeFile, appendFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { readNativeChatTranscriptTail, subscribeNativeChatTranscript } =
      await import('../../src/main/native-chat/transcript-watch')
    const { createNativeChatMessageListProjection } =
      await import('../../src/renderer/src/components/native-chat/native-chat-message-list-projection')
    const directory = await mkdtemp(join(tmpdir(), 'pr31794-live-'))
    const filePath = join(directory, 'session.jsonl')
    const line = (n: number) =>
      `${JSON.stringify({
        type: 'assistant',
        uuid: String(n).padStart(4, '0'),
        timestamp: '2026-06-01T10:00:00Z',
        message: { role: 'assistant', content: `reply ${n}` }
      })}\n`
    await writeFile(filePath, Array.from({ length: 500 }, (_, i) => line(i + 1)).join(''))
    const transport = getMockTransport('env-history', { autoSnapshot: false })
    transport.readSession.mockImplementation((_agent, _session, limit) =>
      readNativeChatTranscriptTail({
        agent: AGENT,
        sessionId: SESSION,
        filePath,
        limit,
        sourceOrder: true
      })
    )
    const session = () => {
      if (!latest) {
        throw new Error('No live session')
      }
      return latest
    }
    const ids = () =>
      createNativeChatMessageListProjection()(session().messages).conversation.map((row) => row.id)
    await render({
      paneKey: PANE,
      agent: AGENT,
      sessionId: SESSION,
      runtimeEnvironmentId: 'env-history'
    })
    const subscription = await subscribeNativeChatTranscript({
      agent: AGENT,
      sessionId: SESSION,
      filePath,
      sourceOrder: true,
      initialLimit: 300,
      debounceMs: 5,
      reconciliationIntervalMs: 20,
      onInitialSnapshot: (messages, hasMore) =>
        act(() => transport.emit({ type: 'snapshot', messages, hasMore })),
      onAppend: (messages) => act(() => transport.emit({ type: 'appended', messages })),
      onReplace: (messages, hasMore) =>
        act(() => transport.emit({ type: 'replacement', messages, hasMore }))
    })
    try {
      await expect
        .poll(async () => {
          await flush()
          return session().messages.length
        })
        .toBe(300)
      await act(async () => {
        await session().loadEarlier()
      })
      expect(ids()).toEqual(Array.from({ length: 500 }, (_, i) => String(i + 1).padStart(4, '0')))
      await appendFile(filePath, line(501))
      await expect
        .poll(async () => {
          await flush()
          return session().messages.length
        })
        .toBe(501)
      expect(ids().at(-1)).toBe('0501')
      expect(transport.subscribe).toHaveBeenCalledOnce()
    } finally {
      subscription.unsubscribe()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
