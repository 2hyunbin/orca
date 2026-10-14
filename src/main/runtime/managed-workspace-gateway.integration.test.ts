import { afterEach, expect, it, vi } from 'vitest'
import { managedWorkspaceGatewayFixture } from './managed-workspace-gateway.test-fixture'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import { openRemoteRuntimePassthroughSocket } from '../../shared/remote-runtime-passthrough-socket'

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
async function fixture() {
  const f = await managedWorkspaceGatewayFixture()
  cleanups.push(() => f.close())
  return f
}

it('forwards encrypted requests to the child and preserves arbitrary user content', async () => {
  const f = await fixture()
  const token = f.controller.pairing.deviceToken
  const result = await sendRemoteRuntimeRequest(
    f.gateway,
    'terminal.gatewayProbe',
    {
      text: token,
      contents: `file contains ${token}`,
      client: { id: token, type: 'desktop' },
      clientId: token
    },
    10000
  )
  expect(result).toMatchObject({
    ok: true,
    _meta: { runtimeId: f.child.runtime.getRuntimeId() },
    result: { kind: 'child', params: { text: token, contents: `file contains ${token}` } }
  })
  expect(f.calls).toEqual({ controller: 0, child: 1 })
})

it('passes binary traffic through both encrypted sessions', async () => {
  const f = await fixture()
  const text = vi.fn()
  const binary = vi.fn()
  const socket = await openRemoteRuntimePassthroughSocket(
    f.gateway,
    [],
    { onText: text, onBinary: binary, onClose: vi.fn() },
    { timeoutMs: 5000 }
  )
  cleanups.push(() => socket.close())
  expect(socket.send(JSON.stringify({ id: 'binary', method: 'test.gatewayBinary' }))).toBe(true)
  await vi.waitFor(() => expect(text).toHaveBeenCalled())
  expect(socket.sendBinary(new Uint8Array([11, 22, 33]))).toBe(true)
  await vi.waitFor(() =>
    expect(binary).toHaveBeenCalledExactlyOnceWith(new Uint8Array([11, 22, 33]))
  )
  expect(f.calls).toEqual({ controller: 0, child: 1 })
})

it('denies pairing administration and unknown methods without touching either workspace', async () => {
  const f = await fixture()
  for (const method of [
    'pairing.getEndpoints',
    'pairing.managedRuntimeSession.open',
    'test.unknown'
  ]) {
    expect(await sendRemoteRuntimeRequest(f.gateway, method, {}, 5000)).toMatchObject({
      ok: false,
      error: { code: 'forbidden' }
    })
  }
  expect(f.calls).toEqual({ controller: 0, child: 0 })
})

it('retires live gateway sockets with their managed environment', async () => {
  const f = await fixture()
  const text = vi.fn()
  const closed = vi.fn()
  const socket = await openRemoteRuntimePassthroughSocket(
    f.gateway,
    [],
    { onText: text, onBinary: vi.fn(), onClose: closed },
    { timeoutMs: 5000 }
  )
  cleanups.push(() => socket.close())
  socket.send(JSON.stringify({ id: 'probe', method: 'terminal.gatewayProbe', params: {} }))
  await vi.waitFor(() => expect(text).toHaveBeenCalled())
  f.retire()
  await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1))
  expect(socket.send('after retirement')).toBe(false)
})

it('refuses an outdated generation without dispatching to the controller', async () => {
  const f = await fixture()
  f.changeGeneration()
  expect(
    await sendRemoteRuntimeRequest(f.gateway, 'terminal.gatewayProbe', {}, 5000)
  ).toMatchObject({
    ok: false,
    error: {
      code: 'remote_runtime_unavailable',
      message: expect.stringContaining('Reconnect or update')
    }
  })
  expect(f.calls).toEqual({ controller: 0, child: 0 })
})

it('cancels pending setup without opening a child credential or running queued work', async () => {
  const f = await fixture()
  let release: (() => void) | undefined
  f.delayResolve(
    new Promise<void>((resolve) => {
      release = resolve
    })
  )
  const grant = vi.spyOn(f.child.rpc.getDeviceRegistry()!.managedSessions, 'open')
  const socket = await openRemoteRuntimePassthroughSocket(
    f.gateway,
    [],
    {
      onText: vi.fn(),
      onBinary: vi.fn(),
      onClose: vi.fn()
    },
    { timeoutMs: 5000 }
  )
  cleanups.push(() => socket.close())
  socket.send(JSON.stringify({ id: 'pending', method: 'terminal.gatewayProbe', params: {} }))
  await vi.waitFor(() => expect(f.resolving()).toBe(1))
  socket.close()
  await vi.waitFor(() => expect(f.controller.rpc.readClientActivity().openConnections).toBe(0))
  release?.()
  await vi.waitFor(() => expect(f.closedHosts()).toBe(1))
  expect(grant).not.toHaveBeenCalled()
  expect(f.calls).toEqual({ controller: 0, child: 0 })
})

it('bounds frames retained during pending setup', async () => {
  const f = await fixture()
  let release: (() => void) | undefined
  f.delayResolve(
    new Promise<void>((resolve) => {
      release = resolve
    })
  )
  const closed = vi.fn()
  const socket = await openRemoteRuntimePassthroughSocket(
    f.gateway,
    [],
    {
      onText: vi.fn(),
      onBinary: vi.fn(),
      onClose: closed
    },
    { timeoutMs: 5000 }
  )
  cleanups.push(() => socket.close())
  for (let index = 0; index < 65; index++) {
    socket.send(JSON.stringify({ id: String(index), method: 'terminal.gatewayProbe', params: {} }))
  }
  await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1))
  release?.()
  await vi.waitFor(() => expect(f.closedHosts()).toBe(1))
  expect(f.calls).toEqual({ controller: 0, child: 0 })
})

it('closes both sides when the desktop pairing is revoked', async () => {
  const f = await fixture()
  const text = vi.fn()
  const closed = vi.fn()
  const socket = await openRemoteRuntimePassthroughSocket(
    f.gateway,
    [],
    {
      onText: text,
      onBinary: vi.fn(),
      onClose: closed
    },
    { timeoutMs: 5000 }
  )
  cleanups.push(() => socket.close())
  socket.send(JSON.stringify({ id: 'probe', method: 'terminal.gatewayProbe', params: {} }))
  await vi.waitFor(() => expect(text).toHaveBeenCalled())
  const parentId = f.controller.pairing.pairedDeviceId
  if (!parentId) {
    throw new Error('missing desktop pairing')
  }
  expect(f.controller.rpc.revokeRuntimeAccess(parentId)).toBe(true)
  await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1))
  await vi.waitFor(() => expect(f.child.rpc.readClientActivity().openConnections).toBe(0))
})

it('authenticates audience-bound gateway credentials and reports the controller device with child runtime identity', async () => {
  const f = await fixture()
  const { managedWorkspaceGatewayCredential } =
    await import('../../shared/managed-workspace-gateway-credential')
  const connection = {
    ...f.gateway,
    credential: {
      kind: 'token' as const,
      deviceToken: managedWorkspaceGatewayCredential(f.controller.pairing.deviceToken, 'devbox', 1)
    }
  }
  const status = await sendRemoteRuntimeRequest(connection, 'status.get', {}, 5000)
  expect(status).toMatchObject({
    ok: true,
    _meta: { runtimeId: f.child.runtime.getRuntimeId() },
    result: {
      runtimeId: f.child.runtime.getRuntimeId(),
      pairedDeviceId: f.controller.pairing.pairedDeviceId
    }
  })
  expect(f.calls).toEqual({ controller: 0, child: 0 })
})

it('rejects gateway credentials at the controller root and at another target generation', async () => {
  const f = await fixture()
  const { managedWorkspaceGatewayCredential } =
    await import('../../shared/managed-workspace-gateway-credential')
  const credential = {
    kind: 'token' as const,
    deviceToken: managedWorkspaceGatewayCredential(f.controller.pairing.deviceToken, 'devbox', 1)
  }
  for (const endpoint of [
    f.controller.connection.endpoint,
    f.gateway.endpoint.replace(/\/1$/u, '/2')
  ]) {
    await expect(
      sendRemoteRuntimeRequest(
        { ...f.gateway, endpoint, credential },
        'terminal.gatewayProbe',
        {},
        5000
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
  }
  expect(f.calls).toEqual({ controller: 0, child: 0 })
})
