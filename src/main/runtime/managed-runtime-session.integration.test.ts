import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'
import { parsePairingCode, encodePairingOffer } from '../../shared/pairing'
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import { openRemoteRuntimePassthroughSocket } from '../../shared/remote-runtime-passthrough-socket'
import {
  MANAGED_RUNTIME_SESSION_CAPABILITY,
  type ManagedRuntimeSessionGrant
} from '../../shared/managed-runtime-session-contract'
import {
  authenticateMobileWsSession,
  createEncryptedWsResponseReader,
  sendEncryptedWsRequest,
  waitForWsClose
} from './runtime-rpc-mobile-ws-test-harness'
import { ALL_RPC_METHODS } from './rpc/methods'
import { defineStreamingMethod } from './rpc/core'
import { encryptBytes } from './rpc/e2ee-crypto'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})
async function fixture(binaryMessages: number[][] = [], echoBinary = false) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-managed-session-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Reuse the sibling RPC fixture's store surface required by these session/status methods.
  const runtime = new OrcaRuntimeService(makeStore() as never)
  const server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: dir,
    enableWebSocket: true,
    wsPort: 0,
    methods: [
      ...ALL_RPC_METHODS,
      defineStreamingMethod({
        name: 'test.managedSessionBinary',
        permission: 'workspace',
        params: null,
        handler: async (_params, context, emit) => {
          const release = context.registerBinaryMessageHandler?.((bytes) => {
            binaryMessages.push(Array.from(bytes))
            if (echoBinary) {
              context.sendBinary?.(bytes)
            }
            emit({ type: 'received' })
          })
          emit({ type: 'ready' })
          try {
            await new Promise<void>((resolve) => {
              if (context.signal?.aborted) {
                resolve()
              } else {
                context.signal?.addEventListener('abort', () => resolve(), { once: true })
              }
            })
          } finally {
            release?.()
          }
        }
      })
    ]
  })
  await server.start()
  cleanups.push(() => server.stop())
  const offer = server.createPairingOffer({
    address: '127.0.0.1',
    name: 'Controller',
    scope: 'runtime'
  })
  if (!offer.available) {
    throw new Error('pairing unavailable')
  }
  const pairing = parsePairingCode(offer.pairingUrl)
  if (!pairing) {
    throw new Error('invalid pairing')
  }
  const parent = pairedRuntimeConnectionFromOffer(pairing)
  const opened = await sendRemoteRuntimeRequest<ManagedRuntimeSessionGrant>(
    parent,
    'pairing.managedRuntimeSession.open',
    { subjectKey: 'desktop-installation', name: 'Laptop via controller' },
    5000
  )
  if (!opened.ok) {
    throw new Error(JSON.stringify(opened.error))
  }
  const grant = opened.result
  const child = {
    ...parent,
    pairedDeviceId: grant.deviceId,
    credential: { kind: 'token' as const, deviceToken: grant.token }
  }
  return { dir, server, pairing, parent, grant, child }
}

it('uses an encrypted session with paired permissions and no persisted credential', async () => {
  const { dir, server, parent, grant, child } = await fixture()
  const status = await sendRemoteRuntimeRequest<{
    deviceScope: string
    pairedDeviceId: string
    capabilities: string[]
  }>(child, 'status.get', {}, 5000)
  expect(status).toMatchObject({
    ok: true,
    result: { deviceScope: 'runtime', pairedDeviceId: grant.deviceId }
  })
  expect(status.ok && status.result.capabilities).toContain(MANAGED_RUNTIME_SESSION_CAPABILITY)
  const registry = server.getDeviceRegistry()
  if (!registry) {
    throw new Error('missing registry')
  }
  expect(registry.listDevices().some((d) => d.deviceId === grant.deviceId)).toBe(false)
  const saved = readFileSync(join(dir, DEVICE_REGISTRY_FILENAME), 'utf8')
  expect(saved).not.toContain(grant.token)
  expect(saved).not.toContain(grant.deviceId)
  expect(await sendRemoteRuntimeRequest(child, 'pairing.getEndpoints', {}, 5000)).toMatchObject({
    ok: false,
    error: { code: 'forbidden' }
  })
  expect(
    await sendRemoteRuntimeRequest(
      child,
      'pairing.managedRuntimeSession.open',
      { subjectKey: 'escalate', name: 'Other' },
      5000
    )
  ).toMatchObject({ ok: false })
  expect(
    await sendRemoteRuntimeRequest(
      child,
      'pairing.delegatedMobileDevice.sync',
      { phones: [{ phoneKey: 'phone', name: 'Phone' }] },
      5000
    )
  ).toMatchObject({ ok: false })
  expect(() => registry.forkDeviceKey(grant.deviceId, 'unused', 'Persist')).toThrow(
    'cannot_persist'
  )
  expect(
    await sendRemoteRuntimeRequest(
      parent,
      'pairing.managedRuntimeSession.renew',
      { deviceId: grant.deviceId },
      5000
    )
  ).toMatchObject({ ok: true })
})

it('revalidates the session principal before delivering encrypted binary frames', async () => {
  const messages: number[][] = []
  const { server, pairing, grant } = await fixture(messages)
  const session = await authenticateMobileWsSession(
    encodePairingOffer({ ...pairing, deviceToken: grant.token, pairedDeviceId: grant.deviceId })
  )
  cleanups.push(() => session.ws.terminate())
  const reader = createEncryptedWsResponseReader(session)
  cleanups.push(() => reader.dispose())
  sendEncryptedWsRequest(session, { id: 'binary', method: 'test.managedSessionBinary' })
  expect(await reader.next('binary')).toMatchObject({ ok: true, result: { type: 'ready' } })
  session.ws.send(Buffer.from(encryptBytes(new Uint8Array([1, 2, 3]), session.sharedKey)))
  expect(await reader.next('binary')).toMatchObject({ ok: true, result: { type: 'received' } })
  const registry = server.getDeviceRegistry()
  if (!registry) {
    throw new Error('missing registry')
  }
  const authorization = vi
    .spyOn(registry, 'resolveAuthenticatedPrincipal')
    .mockReturnValueOnce(null)
  const closed = waitForWsClose(session.ws)
  session.ws.send(Buffer.from(encryptBytes(new Uint8Array([4, 5, 6]), session.sharedKey)))
  await closed
  authorization.mockRestore()
  expect(messages).toEqual([[1, 2, 3]])
})

it('revoking the session closes its authenticated socket and rejects the old bearer', async () => {
  const { server, parent, grant, child } = await fixture()
  const closed = vi.fn()
  const socket = await openRemoteRuntimePassthroughSocket(
    child,
    [],
    { onText: vi.fn(), onBinary: vi.fn(), onClose: closed },
    { timeoutMs: 5000 }
  )
  cleanups.push(() => socket.close())
  expect(
    await sendRemoteRuntimeRequest(
      parent,
      'pairing.managedRuntimeSession.revoke',
      { deviceId: grant.deviceId },
      5000
    )
  ).toMatchObject({ ok: true, result: { revoked: true } })
  await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1))
  expect(server.getDeviceRegistry()?.validateToken(grant.token)).toBeNull()
  await expect(
    openRemoteRuntimePassthroughSocket(
      child,
      [],
      { onText: vi.fn(), onBinary: vi.fn(), onClose: vi.fn() },
      { timeoutMs: 5000 }
    )
  ).rejects.toMatchObject({ code: 'unauthorized' })
})

it('carries encrypted binary input and output on the reusable passthrough session', async () => {
  const messages: number[][] = []
  const { child } = await fixture(messages, true)
  const text = vi.fn()
  const binary = vi.fn()
  const socket = await openRemoteRuntimePassthroughSocket(
    child,
    [],
    {
      onText: text,
      onBinary: binary,
      onClose: vi.fn()
    },
    { timeoutMs: 5000 }
  )
  cleanups.push(() => socket.close())
  expect(socket.send(JSON.stringify({ id: 'binary', method: 'test.managedSessionBinary' }))).toBe(
    true
  )
  await vi.waitFor(() => expect(text).toHaveBeenCalled())
  expect(socket.sendBinary(new Uint8Array([7, 8, 9]))).toBe(true)
  await vi.waitFor(() => expect(binary).toHaveBeenCalledExactlyOnceWith(new Uint8Array([7, 8, 9])))
  expect(messages).toEqual([[7, 8, 9]])
  socket.close()
  expect(socket.sendBinary(new Uint8Array([10]))).toBe(false)
})

it('revoking the parent closes all child sessions immediately', async () => {
  const { server, pairing, grant } = await fixture()
  const session = await authenticateMobileWsSession(
    encodePairingOffer({ ...pairing, deviceToken: grant.token, pairedDeviceId: grant.deviceId })
  )
  cleanups.push(() => session.ws.terminate())
  const reader = createEncryptedWsResponseReader(session)
  cleanups.push(() => reader.dispose())
  sendEncryptedWsRequest(session, { id: 'status', method: 'status.get' })
  expect(await reader.next('status')).toMatchObject({ ok: true })
  const closed = waitForWsClose(session.ws)
  const parentId = pairing.pairedDeviceId
  if (!parentId) {
    throw new Error('missing parent device')
  }
  expect(server.revokeRuntimeAccess(parentId)).toBe(true)
  await closed
  expect(server.getDeviceRegistry()?.validateToken(grant.token)).toBeNull()
})
