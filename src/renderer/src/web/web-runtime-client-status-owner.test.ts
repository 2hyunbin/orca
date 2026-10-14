import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pairedRuntimeConnectionFromOffer } from '../../../shared/paired-runtime-connection'
import { runtimeHostStatusFailure } from '../../../shared/runtime-host-status'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { WebRuntimeClient } from './web-runtime-client'
import { WebRuntimeConnectionTransport } from './web-runtime-connection-transport'

class ConnectingSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  readyState = ConnectingSocket.CONNECTING
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close() {}
  send() {}
}
describe('web shared status ownership', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
      btoa: (value: string) => Buffer.from(value, 'binary').toString('base64')
    })
    vi.stubGlobal('WebSocket', ConnectingSocket)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  it('detaches one cancelled status observer while the shared verification serves another', async () => {
    let finish: (value: RuntimeRpcResponse<unknown>) => void = () => {}
    const reply = new Promise<RuntimeRpcResponse<unknown>>((resolve) => {
      finish = resolve
    })
    let requestSignal: AbortSignal | undefined
    const transport = vi
      .spyOn(WebRuntimeConnectionTransport.prototype, 'call')
      .mockImplementation((_method, _params, options) => {
        requestSignal = options?.signal
        return reply
      })
    const client = new WebRuntimeClient(
      pairedRuntimeConnectionFromOffer({
        v: 2,
        endpoint: 'ws://127.0.0.1:6768',
        deviceToken: 'token',
        publicKeyB64: Buffer.alloc(32).toString('base64')
      }),
      {
        status: {
          environmentId: 'env-a',
          pairingRevision: 1,
          publish: () => {},
          verified: () => {}
        }
      }
    )
    try {
      const controller = new AbortController()
      const cancelled = client.call('status.get', undefined, { signal: controller.signal })
      const rejection = expect(cancelled).rejects.toThrow()
      const other = client.call('status.get')
      controller.abort()
      await rejection
      expect(transport).toHaveBeenCalledOnce()
      expect(requestSignal?.aborted).toBe(false)
      finish(runtimeHostStatusFailure('runtime_unavailable', 'Reply to the remaining observer'))
      expect((await other).ok).toBe(false)
    } finally {
      client.close()
      transport.mockRestore()
    }
  })
})
