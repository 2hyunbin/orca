import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { devicePrincipalOf } from './device-principal'
import { DeviceRegistry } from './device-registry'
import type { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import type { AuthenticatedMobileSocket } from './rpc/mobile-socket-wiring'

function keyedServer() {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-device-key-dispatch-'))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: status.get only reads these three members.
  const runtime = {
    configureNotificationDismissalStore: () => {},
    getRuntimeId: () => 'test-runtime',
    getStatus: vi.fn().mockResolvedValue({ graphStatus: 'ok' })
  } as unknown as OrcaRuntimeService
  const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
  const registry = new DeviceRegistry(userDataPath)
  server['deviceRegistry'] = registry
  const legacy = registry.addDevice('Laptop', 'runtime')
  const keyed = registry.forkDeviceKey(
    legacy.deviceId,
    Buffer.alloc(32, 5).toString('base64'),
    'Mac'
  )
  const socket: AuthenticatedMobileSocket = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch only uses ws as a map key for abort registration.
    ws: {} as AuthenticatedMobileSocket['ws'],
    connectionId: 'connection-1',
    transcriptHashB64: Buffer.alloc(32).toString('base64'),
    device: devicePrincipalOf(keyed),
    clientCapabilities: [],
    transport: { transport: 'direct' }
  }
  const send = async (request: Record<string, unknown>) => {
    const replies: string[] = []
    await server['handleWebSocketMessage'](
      JSON.stringify(request),
      (response) => replies.push(response),
      () => {},
      undefined,
      undefined,
      null,
      socket
    )
    const reply: unknown = JSON.parse(replies.at(-1)!)
    return reply
  }
  return { server, registry, keyed, legacy, send }
}

describe('requests on a key-authenticated socket', () => {
  it('dispatch with the device id as client id and no token', async () => {
    const { server, keyed, send } = keyedServer()
    const dispatch = vi.spyOn(server['dispatcher'], 'dispatchStreaming')
    const reply = await send({ id: 'r1', method: 'status.get' })
    expect(reply).not.toMatchObject({ error: { code: 'unauthorized' } })
    expect(dispatch.mock.calls[0]?.[2]).toMatchObject({
      clientId: keyed.deviceId,
      pairedDeviceId: keyed.deviceId
    })
  })

  it('refuses a request that carries any token, and every request once the row is revoked', async () => {
    const { registry, keyed, legacy, send } = keyedServer()
    expect(await send({ id: 'r1', method: 'status.get', deviceToken: legacy.token })).toMatchObject(
      {
        ok: false,
        error: { code: 'unauthorized' }
      }
    )
    registry.removeDevice(keyed.deviceId)
    expect(await send({ id: 'r2', method: 'status.get' })).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' }
    })
  })
})
