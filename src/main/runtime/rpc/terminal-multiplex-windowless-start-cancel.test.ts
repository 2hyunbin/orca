import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame
} from '../../../shared/terminal-stream-protocol'
import {
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe
} from './terminal-multiplex-test-harness'

describe('terminal multiplex RPC without a window', () => {
  it('ends a cancelled pending pane start silently instead of reporting no_connected_pty', async () => {
    let startSignal: AbortSignal | undefined
    // Mirrors the runtime: a cancelled start resolves null rather than rejecting.
    const startPaneForHandle = vi.fn(
      (_handle: string, signal?: AbortSignal) =>
        new Promise<string | null>((resolve) => {
          startSignal = signal
          signal?.addEventListener('abort', () => resolve(null), { once: true })
        })
    )
    const harness = startDesktopMultiplexSubscribe({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: null }),
      startPaneForHandle
    })
    await vi.waitFor(() =>
      expect(harness.messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() => expect(startPaneForHandle).toHaveBeenCalled())

    harness.handlers.get(7)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Unsubscribe,
          streamId: 7,
          seq: 2,
          payload: new Uint8Array()
        })
      )!
    )
    expect(startSignal?.aborted).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const opcodes = harness.binaryFrames.map((frame) => decodeTerminalStreamFrame(frame)?.opcode)
    // Why: old desktops read no_connected_pty as "terminal gone"; a cancel must not send it.
    expect(opcodes).not.toContain(TerminalStreamOpcode.Error)
    expect(harness.messages.some((msg) => JSON.parse(msg).result?.type === 'end')).toBe(false)
    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })
})
