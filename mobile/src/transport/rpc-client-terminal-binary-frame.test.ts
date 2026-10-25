import { describe, expect, it, vi } from 'vitest'
import {
  createUnreadableTerminalFrameState,
  handleTerminalBinaryFrame
} from './rpc-client-terminal-binary-frame'
import { RpcClientTerminalStreamRouter } from './rpc-client-terminal-stream-router'
import {
  encodeTerminalStreamFrame,
  TerminalStreamOpcode
} from '../../../src/shared/terminal-stream-protocol'

function encodeFrame(opcode: TerminalStreamOpcode, streamId: number, payload: unknown): Uint8Array {
  const body =
    typeof payload === 'string'
      ? new TextEncoder().encode(payload)
      : new TextEncoder().encode(JSON.stringify(payload))
  return encodeTerminalStreamFrame({
    opcode,
    streamId,
    seq: 1,
    payload: body
  })
}

describe('handleTerminalBinaryFrame', () => {
  it('routes terminal metadata frames to the stream listener', () => {
    const listener = vi.fn()

    handleTerminalBinaryFrame(
      encodeFrame(TerminalStreamOpcode.Metadata, 42, { cwd: '/repo/src' }),
      {
        terminalSnapshots: new Map(),
        unreadableFrames: createUnreadableTerminalFrameState(),
        getListener: (streamId) => (streamId === 42 ? listener : undefined)
      }
    )

    expect(listener).toHaveBeenCalledWith({ type: 'metadata', streamId: 42, cwd: '/repo/src' })
  })

  it('writes a transformed output span from a host that predates text-only subscribe', () => {
    const listener = vi.fn()

    handleTerminalBinaryFrame(
      encodeFrame(TerminalStreamOpcode.OutputSpan, 7, {
        data: 'after the stripped query',
        rawLength: 31,
        transformed: true
      }),
      {
        terminalSnapshots: new Map(),
        unreadableFrames: createUnreadableTerminalFrameState(),
        getListener: () => listener
      }
    )

    expect(listener).toHaveBeenCalledWith({
      type: 'data',
      streamId: 7,
      chunk: 'after the stripped query'
    })
  })

  it('ends a stream on an unreadable frame, throttling resets without stranding a stream', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let now = 1_000
    const listener = vi.fn()
    const options = {
      terminalSnapshots: new Map(),
      unreadableFrames: createUnreadableTerminalFrameState(() => now),
      getListener: () => listener
    }

    handleTerminalBinaryFrame(unreadableFrame(9), options)
    handleTerminalBinaryFrame(unreadableFrame(9), options)
    // Another pane hits one inside the window: logged, not reset yet.
    handleTerminalBinaryFrame(unreadableFrame(10), options)
    handleTerminalBinaryFrame(unreadableFrame(10), options)
    now += 30_000
    // Its next unreadable frame after the window still ends it.
    handleTerminalBinaryFrame(unreadableFrame(10), options)

    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ type: 'error', streamId: 9 }),
      expect.objectContaining({ type: 'error', streamId: 10 })
    ])
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('lets a released stream id that the host reuses be reset again', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const router = new RpcClientTerminalStreamRouter()
      const first = vi.fn()
      router.register('request-1', 5, first)
      router.handle(unreadableFrame(5))
      router.reset('request-1')
      vi.advanceTimersByTime(30_000)
      const second = vi.fn()
      router.register('request-2', 5, second)
      router.handle(unreadableFrame(5))

      expect(first).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', streamId: 5 }))
      expect(second).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', streamId: 5 }))
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })
})

function unreadableFrame(streamId: number): Uint8Array {
  const frame = encodeFrame(TerminalStreamOpcode.Output, streamId, 'text')
  // An opcode no build knows yet, as a newer host could send.
  frame[2] = 250
  return frame
}
