import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal'

function stubRuntime(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    subscribeToPtyExit: vi.fn(() => vi.fn()),
    registerRemoteTerminalViewSubscriber: () => () => {},
    getPtyOutputSequence: () => 0,
    replaceHeadlessTerminalFromRendererSnapshotForRecovery: () => {},
    serializeRendererTerminalBuffer: async () => null,
    hasHeadlessTerminalState: () => true,
    ...overrides
  } as OrcaRuntimeService
}

const makeRequest = (method: string, params?: unknown): RpcRequest => ({
  id: 'req-1',
  authToken: 'tok',
  method,
  params
})

describe('terminal.subscribe for an aborted request', () => {
  it('does not start the pane for an already-aborted mobile subscribe', async () => {
    const controller = new AbortController()
    controller.abort()
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue(null),
      startPaneForHandle: vi.fn(),
      readTerminal: vi.fn()
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    await dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', {
        terminal: 'terminal-1',
        client: { id: 'phone-1', type: 'mobile' },
        capabilities: { terminalBinaryStream: 1 }
      }),
      vi.fn(),
      {
        signal: controller.signal,
        connectionId: 'conn-phone',
        sendBinary: vi.fn(),
        registerBinaryStreamHandler: vi.fn(() => vi.fn())
      }
    )

    expect(runtime.startPaneForHandle).not.toHaveBeenCalled()
    expect(runtime.readTerminal).not.toHaveBeenCalled()
  })
})
