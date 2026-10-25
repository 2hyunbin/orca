import { describe, expect, it, vi } from 'vitest'
import {
  createUnreadableTerminalFrameState,
  handleTerminalBinaryFrame
} from './rpc-client-terminal-binary-frame'
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

  it('ends the stream on an unreadable frame, at most once per stream and per interval', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let now = 1_000
    const options = {
      terminalSnapshots: new Map(),
      unreadableFrames: createUnreadableTerminalFrameState(() => now),
      getListener: () => listener
    }
    const listener = vi.fn()
    const unreadable = (streamId: number): Uint8Array => {
      const frame = encodeFrame(TerminalStreamOpcode.Output, streamId, 'text')
      // An opcode no build knows yet, as a newer host could send.
      frame[2] = 250
      return frame
    }

    handleTerminalBinaryFrame(unreadable(9), options)
    handleTerminalBinaryFrame(unreadable(9), options)
    // The resubscribe's stream hits the same frame right away: logged, but not reset again.
    handleTerminalBinaryFrame(unreadable(10), options)
    now += 30_000
    handleTerminalBinaryFrame(unreadable(11), options)

    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ type: 'error', streamId: 9 }),
      expect.objectContaining({ type: 'error', streamId: 11 })
    ])
    expect(warn).toHaveBeenCalledTimes(3)
    warn.mockRestore()
  })
})
