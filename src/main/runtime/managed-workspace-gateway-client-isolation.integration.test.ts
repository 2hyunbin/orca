import { expect, it, vi } from 'vitest'
import { managedWorkspaceGatewayFixture } from './managed-workspace-gateway.test-fixture'
import { openRemoteRuntimePassthroughSocket } from '../../shared/remote-runtime-passthrough-socket'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

it('keeps a second paired client alive when its sibling gateway session closes', async () => {
  const f = await managedWorkspaceGatewayFixture()
  const sockets: Awaited<ReturnType<typeof openRemoteRuntimePassthroughSocket>>[] = []
  try {
    const controllerRegistry = f.controller.rpc.getDeviceRegistry()
    if (!controllerRegistry) {
      throw new Error('Controller device registry unavailable')
    }
    const device = controllerRegistry.addDevice('Second controller client', 'runtime')
    const second = {
      ...f.gateway,
      pairedDeviceId: device.deviceId,
      credential: { kind: 'token' as const, deviceToken: device.token }
    }
    expect(second.pairedDeviceId).not.toBe(f.gateway.pairedDeviceId)
    const registry = f.child.rpc.getDeviceRegistry()
    if (!registry) {
      throw new Error('Child device registry unavailable')
    }
    const opened = vi.spyOn(registry.managedSessions, 'open')
    const text = [vi.fn(), vi.fn()]
    for (const [index, connection] of [f.gateway, second].entries()) {
      const socket = await openRemoteRuntimePassthroughSocket(
        connection,
        [],
        {
          onText: text[index]!,
          onBinary: vi.fn(),
          onClose: vi.fn()
        },
        { timeoutMs: 5000 }
      )
      sockets.push(socket)
      socket.send(
        JSON.stringify({ id: `client-${index}`, method: 'terminal.gatewayProbe', params: {} })
      )
      await vi.waitFor(() => expect(text[index]).toHaveBeenCalledTimes(1))
    }
    const [firstGrant, secondGrant] = opened.mock.results
    if (firstGrant?.type !== 'return' || secondGrant?.type !== 'return') {
      throw new Error('Child sessions unavailable')
    }
    expect(firstGrant.value.deviceId).not.toBe(secondGrant.value.deviceId)
    sockets[0]!.close()
    await vi.waitFor(() =>
      expect(registry.managedSessions.resolve(firstGrant.value.deviceId)).toBeNull()
    )
    expect(registry.managedSessions.resolve(secondGrant.value.deviceId)).not.toBeNull()
    expect(
      sockets[1]!.send(
        JSON.stringify({ id: 'still-live', method: 'terminal.gatewayProbe', params: {} })
      )
    ).toBe(true)
    await vi.waitFor(() => expect(text[1]).toHaveBeenCalledTimes(2))
    expect(f.calls).toEqual({ controller: 0, child: 3 })
  } finally {
    for (const socket of sockets) {
      socket.close()
    }
    await f.close()
  }
})
