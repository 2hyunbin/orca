import { describe, expect, it, vi } from 'vitest'
import { handleTerminalBinaryFrame } from './rpc-client-terminal-binary-frame'
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
      { terminalSnapshots: new Map(), getListener: () => listener }
    )

    expect(listener).toHaveBeenCalledWith({
      type: 'data',
      streamId: 7,
      chunk: 'after the stripped query'
    })
  })

  it('ends the stream instead of dropping a frame it cannot read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const listener = vi.fn()
    const frame = encodeFrame(TerminalStreamOpcode.Output, 9, 'text')
    // An opcode no build knows yet, as a newer host could send.
    frame[2] = 250

    handleTerminalBinaryFrame(frame, { terminalSnapshots: new Map(), getListener: () => listener })

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', streamId: 9 }))
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
