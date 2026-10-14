import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../protocol-version'
import { PLUGIN_ENVIRONMENT_PROVIDER_RUNTIME_CAPABILITY } from './plugin-environment-provider-runtime-capability'
import { PluginEnvironmentProviderRuntimeClient } from './plugin-environment-provider-runtime-client'

const transport = vi.hoisted(() => {
  const retirement: { onClosed?: () => void } = {}
  return { request: vi.fn(), close: vi.fn(), retirement }
})
vi.mock('../remote-runtime-request-connection', () => ({
  RemoteRuntimeRequestConnection: class {
    constructor(_pairing: unknown, _capabilities: unknown, lifetime: { onClosed(): void }) {
      transport.retirement.onClosed = lifetime.onClosed
    }
    request = transport.request
    close = transport.close
  }
}))

const clients: PluginEnvironmentProviderRuntimeClient[] = []
const status = {
  runtimeId: 'owned-host',
  capabilities: [PLUGIN_ENVIRONMENT_PROVIDER_RUNTIME_CAPABILITY],
  runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
  minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
}
function reply(result: unknown, runtimeId = 'owned-host') {
  return { id: 'response', ok: true, result, _meta: { runtimeId } }
}
function client(onRetired?: () => void) {
  const value = new PluginEnvironmentProviderRuntimeClient(
    {
      endpoint: 'ws://owned.invalid',
      hostPublicKeyB64: 'fixture',
      credential: { kind: 'token', deviceToken: 'fixture' }
    },
    'owned-host',
    onRetired
  )
  clients.push(value)
  return value
}
beforeEach(() => {
  vi.clearAllMocks()
  transport.request.mockImplementation(async (method: string) =>
    reply(method === 'status.get' ? status : [])
  )
})
afterEach(() => {
  for (const value of clients.splice(0)) {
    value.close()
  }
})

it('coalesces admission and carries the reviewed instance on each call', async () => {
  const value = client()
  await Promise.all([value.call('list', {}), value.call('listSaved', {})])
  expect(transport.request.mock.calls.map(([method]) => method)).toEqual([
    'status.get',
    'plugins.environments.list',
    'plugins.environments.listSaved'
  ])
  expect(transport.request).toHaveBeenLastCalledWith(
    'plugins.environments.listSaved',
    { runtimeId: 'owned-host' },
    15_000,
    expect.any(AbortSignal)
  )
  expect(transport.close).not.toHaveBeenCalled()
})

it.each([
  { reason: 'unsupported host', status: { ...status, capabilities: [] } },
  { reason: 'old protocol', status: { ...status, runtimeProtocolVersion: 0 } },
  { reason: 'replacement host', status: { ...status, runtimeId: 'replacement-host' } },
  { reason: 'malformed status', status: { ...status, capabilities: null } }
])('refuses $reason before sending any provider command', async (fixture) => {
  transport.request.mockResolvedValue(reply(fixture.status))
  const value = client()
  await expect(value.call('list', {})).rejects.toThrow()
  await expect(value.call('list', {})).rejects.toThrow()
  expect(transport.request).toHaveBeenCalledTimes(1)
  expect(transport.close).toHaveBeenCalledTimes(1)
})

it('refuses a response from another instance and retires the review', async () => {
  transport.request
    .mockResolvedValueOnce(reply(status))
    .mockResolvedValueOnce(reply([], 'replacement-host'))
  const value = client()
  await expect(value.call('list', {})).rejects.toThrow('another server instance')
  await expect(value.call('listSaved', {})).rejects.toThrow()
  expect(transport.request).toHaveBeenCalledTimes(2)
})

it('does not replay a lost mutation or reconnect the retired review', async () => {
  transport.request
    .mockResolvedValueOnce(reply(status))
    .mockRejectedValueOnce(new Error('socket lost'))
  const value = client()
  await expect(value.call('saveSsh', { input: { ticketId: randomUUID() } })).rejects.toThrow(
    'socket lost'
  )
  await expect(value.call('list', {})).rejects.toThrow()
  expect(transport.request).toHaveBeenCalledTimes(2)
})

it('rejects late replies after the pane closes and retires only once', async () => {
  let finish: (value: unknown) => void = () => {
    throw new Error('no pending call')
  }
  transport.request.mockResolvedValueOnce(reply(status)).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const retired = vi.fn()
  const value = client(retired)
  const pending = value.call('list', {})
  await vi.waitFor(() => expect(transport.request).toHaveBeenCalledTimes(2))
  value.close()
  transport.retirement.onClosed?.()
  finish(reply([]))
  await expect(pending).rejects.toThrow()
  expect(retired).toHaveBeenCalledTimes(1)
  expect(transport.close).toHaveBeenCalledTimes(1)
})

it('validates input before opening a connection', async () => {
  const value = client()
  await expect(value.call('saveSsh', { input: { ticketId: 'invalid' } })).rejects.toThrow()
  expect(transport.request).not.toHaveBeenCalled()
  await expect(value.call('list', {})).resolves.toEqual([])
})
