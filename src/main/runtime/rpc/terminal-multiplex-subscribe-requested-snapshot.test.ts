import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'

// A park reveal asks the subscribe snapshot for its bounded authoritative image so the
// client never sends a second SnapshotRequest. The echo is the only proof it was served:
// without it (older host, mobile, nothing authoritative) the client asks as before.

type SubscribeOptions = {
  clientType?: 'desktop' | 'mobile'
  snapshotScrollbackRows?: number
  authoritative?: 'image' | 'none'
}

async function subscribeAndCollectSnapshot(options: SubscribeOptions): Promise<{
  meta: Record<string, unknown>
  data: string
  snapshotStarts: number
  defaultSerializes: number
  authoritativeRows: (number | undefined)[]
}> {
  const handlers = new Map<
    number,
    (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
  >()
  const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
  const cleanups = new Map<string, () => void>()
  const serializeTerminalBuffer = vi.fn(async () => ({ data: 'DEFAULT', cols: 80, rows: 24 }))
  const authoritativeRows: (number | undefined)[] = []
  const serializeAuthoritativeTerminalBuffer = vi.fn(
    async (_ptyId: string, opts?: { scrollbackRows?: number }) => {
      authoritativeRows.push(opts?.scrollbackRows)
      return options.authoritative === 'none'
        ? null
        : { data: 'SCREEN', scrollbackAnsi: 'HISTORY|', cols: 80, rows: 24, seq: 7 }
    }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: terminal.multiplex reads only the members stubbed here.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer,
    serializeAuthoritativeTerminalBuffer,
    getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    registerRemoteTerminalViewSubscriber: vi.fn(() => () => {}),
    subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
    getTerminalFitOverride: vi.fn().mockReturnValue(null),
    getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
    handleMobileSubscribe: vi.fn().mockResolvedValue(undefined),
    handleMobileUnsubscribe: vi.fn(),
    registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
      cleanups.set(id, cleanup)
    }),
    cleanupSubscription: vi.fn((id: string) => {
      const cleanup = cleanups.get(id)
      cleanups.delete(id)
      cleanup?.()
    }),
    waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
    updateDesktopViewport: vi.fn().mockResolvedValue(true)
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const request: RpcRequest = {
    id: 'req-1',
    authToken: 'tok',
    method: 'terminal.multiplex',
    params: {}
  }
  const dispatchPromise = dispatcher.dispatchStreaming(request, () => {}, {
    connectionId: 'conn-1',
    sendBinary: (bytes) => {
      binaryFrames.push(bytes)
    },
    registerBinaryStreamHandler: (streamId, handler) => {
      handlers.set(streamId, handler)
      return () => handlers.delete(streamId)
    }
  })
  await vi.runOnlyPendingTimersAsync()
  handlers.get(0)?.(
    decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Subscribe,
        streamId: 0,
        seq: 1,
        payload: encodeTerminalStreamJson({
          streamId: 5,
          terminal: 'terminal-1',
          client: { id: 'client-1', type: options.clientType ?? 'desktop' },
          ...(options.snapshotScrollbackRows === undefined
            ? {}
            : { snapshotScrollbackRows: options.snapshotScrollbackRows })
        })
      })
    )!
  )
  for (let i = 0; i < 5; i += 1) {
    await vi.runOnlyPendingTimersAsync()
  }
  const frames = binaryFrames.map((frame) => decodeTerminalStreamFrame(frame)!)
  const starts = frames.filter((frame) => frame.opcode === TerminalStreamOpcode.SnapshotStart)
  const data = frames
    .filter((frame) => frame.opcode === TerminalStreamOpcode.SnapshotChunk)
    .map((frame) => decodeTerminalStreamText(frame.payload))
    .join('')
  runtime.cleanupSubscription('terminal-multiplex:conn-1')
  await dispatchPromise
  return {
    meta: decodeTerminalStreamJson<Record<string, unknown>>(starts[0]!.payload) ?? {},
    data,
    snapshotStarts: starts.length,
    defaultSerializes: serializeTerminalBuffer.mock.calls.length,
    authoritativeRows
  }
}

describe('terminal.multiplex subscribe-time scrollback request', () => {
  it('serves the requested authoritative image in the one subscribe snapshot and echoes it', async () => {
    vi.useFakeTimers()
    try {
      const result = await subscribeAndCollectSnapshot({ snapshotScrollbackRows: 5000 })
      expect(result.snapshotStarts).toBe(1)
      expect(result.authoritativeRows).toEqual([5000])
      expect(result.defaultSerializes).toBe(0)
      expect(result.data).toBe('HISTORY|SCREEN')
      expect(result.meta).toMatchObject({
        requestedScrollbackRows: 5000,
        scrollbackRows: 5000,
        seq: 7
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('publishes the default image with no echo when the subscribe asks for nothing', async () => {
    vi.useFakeTimers()
    try {
      const result = await subscribeAndCollectSnapshot({})
      expect(result.authoritativeRows).toEqual([])
      expect(result.defaultSerializes).toBeGreaterThan(0)
      expect(result.data).toBe('DEFAULT')
      expect(result.meta).not.toHaveProperty('requestedScrollbackRows')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the default image and stays silent when nothing authoritative can be serialized', async () => {
    vi.useFakeTimers()
    try {
      const result = await subscribeAndCollectSnapshot({
        snapshotScrollbackRows: 5000,
        authoritative: 'none'
      })
      expect(result.data).toBe('DEFAULT')
      expect(result.meta).not.toHaveProperty('requestedScrollbackRows')
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores the request from a mobile subscriber, whose budget is its own', async () => {
    vi.useFakeTimers()
    try {
      const result = await subscribeAndCollectSnapshot({
        clientType: 'mobile',
        snapshotScrollbackRows: 5000
      })
      expect(result.authoritativeRows).toEqual([])
      expect(result.meta).not.toHaveProperty('requestedScrollbackRows')
    } finally {
      vi.useRealTimers()
    }
  })
})
