import { describe, expect, it } from 'vitest'
import { RpcClientRequestTracker } from './rpc-client-request-tracker'
import { RpcClientStreamRegistry } from './rpc-client-stream-registry'
import { RPC_TRANSPORT_FIELDS, withRpcEnvelopeFields } from './rpc-envelope-fields'

const DEVICE_TOKEN = 'device-token'

function wire() {
  const sent: string[] = []
  let counter = 0
  return {
    sent,
    nextId: () => `rpc-${++counter}`,
    sendEncrypted: (request: unknown) => {
      sent.push(JSON.stringify(request))
      return true
    }
  }
}

function tracker(socket: ReturnType<typeof wire>) {
  return new RpcClientRequestTracker({
    nextId: socket.nextId,
    deviceToken: DEVICE_TOKEN,
    getState: () => 'connected',
    waitForConnected: async () => undefined,
    sendEncrypted: socket.sendEncrypted
  })
}

function registry(socket: ReturnType<typeof wire>) {
  return new RpcClientStreamRegistry({
    nextId: socket.nextId,
    deviceToken: DEVICE_TOKEN,
    getState: () => 'connected',
    sendEncrypted: socket.sendEncrypted
  })
}

describe('withRpcEnvelopeFields', () => {
  const request = { id: 'rpc-1', deviceToken: DEVICE_TOKEN, method: 'm', params: { a: 1 } }

  it('hands back the request itself when there is nothing to merge', () => {
    expect(withRpcEnvelopeFields(request, undefined)).toBe(request)
    expect(withRpcEnvelopeFields(request, {})).toBe(request)
  })

  it('adds extra fields beside the transport ones', () => {
    expect(withRpcEnvelopeFields(request, { executionHost: 'runtime:a', n: [1, null] })).toEqual({
      ...request,
      executionHost: 'runtime:a',
      n: [1, null]
    })
  })

  it.each(RPC_TRANSPORT_FIELDS)('never lets the envelope set %s', (field) => {
    const merged = withRpcEnvelopeFields(request, { [field]: 'forged' })
    expect(merged).toEqual(request)
  })

  it('cannot fill in a transport field the request left out', () => {
    const { params: _omitted, ...bare } = request
    expect(JSON.stringify(withRpcEnvelopeFields(bare, { params: 'forged', x: 1 }))).toBe(
      JSON.stringify({ x: 1, ...bare })
    )
  })
})

describe('direct transport envelope', () => {
  it('sends a request with no envelope byte for byte as before', async () => {
    const socket = wire()
    void tracker(socket).sendRequest('status.get', { a: 1 }, { timeoutMs: 1000 })
    await Promise.resolve()
    expect(socket.sent).toEqual([
      '{"id":"rpc-1","deviceToken":"device-token","method":"status.get","params":{"a":1}}'
    ])
  })

  it('merges a request envelope under every transport field', async () => {
    const socket = wire()
    const forged = Object.fromEntries(RPC_TRANSPORT_FIELDS.map((field) => [field, 'forged']))
    void tracker(socket).sendRequest(
      'status.get',
      { a: 1 },
      { envelope: { ...forged, executionHost: 'runtime:a' } }
    )
    await Promise.resolve()
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      id: 'rpc-1',
      deviceToken: DEVICE_TOKEN,
      method: 'status.get',
      params: { a: 1 },
      executionHost: 'runtime:a'
    })
  })

  it('sends a subscribe with no envelope byte for byte as before', () => {
    const socket = wire()
    registry(socket).subscribe('terminal.subscribe', { terminal: 't1' }, () => undefined)
    expect(socket.sent).toEqual([
      '{"id":"rpc-1","deviceToken":"device-token","method":"terminal.subscribe","params":{"terminal":"t1"}}'
    ])
  })

  it('keeps a stream envelope on its subscribe, its replay and its unsubscribe', () => {
    const socket = wire()
    const streams = registry(socket)
    const dispose = streams.subscribe('terminal.subscribe', { terminal: 't1' }, () => undefined, {
      envelope: { executionHost: 'runtime:a', id: 'forged' }
    })
    streams.markForReplay()
    streams.replayAfterAuthentication()
    dispose()
    const frames = socket.sent.map((json) => JSON.parse(json))
    expect(frames.map((frame) => [frame.method, frame.executionHost, frame.id])).toEqual([
      ['terminal.subscribe', 'runtime:a', 'rpc-1'],
      ['terminal.subscribe', 'runtime:a', 'rpc-1'],
      ['terminal.unsubscribe', 'runtime:a', 'rpc-2']
    ])
  })
})
