import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clientInstances, resetSshConnectionMocks, ssh2Mock } from './ssh-connection-test-harness'
import { createCallbacks, createTarget } from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'
import { setEnvironmentProviderSshAuthorizer } from './environment-provider-ssh-admission'

vi.mock('ssh2', async () => (await import('./ssh-connection-test-harness')).createSsh2Module())
vi.mock('./system-ssh-binary', async () =>
  (await import('./ssh-connection-test-harness')).createSystemSshBinaryModule()
)
vi.mock('./ssh-system-fallback', async () =>
  (await import('./ssh-connection-test-harness')).createSystemFallbackModule()
)
vi.mock('./ssh-control-socket', async () =>
  (await import('./ssh-connection-test-harness')).createControlSocketModule()
)
vi.mock('./ssh-config-parser', async () =>
  (await import('./ssh-connection-test-harness')).createSshConfigParserModule()
)
function target() {
  return createTarget({
    environmentProvider: {
      version: 1,
      binding: {
        executionHostId: 'local',
        providerId: 'company.platform/pods',
        contextId: 'company/account',
        sourceDigest: 'a'.repeat(64),
        recipeDigest: 'b'.repeat(64)
      },
      resourceId: 'devbox',
      resourceRevision: 'r1',
      connection: {
        type: 'ssh',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        projectRoot: '/projects'
      }
    }
  })
}
beforeEach(resetSshConnectionMocks)
afterEach(() => setEnvironmentProviderSshAuthorizer(null))
describe('provider SSH leases fence pending and live transports', () => {
  it('closes a live transport and refuses further commands when provider authority is withdrawn', async () => {
    const controller = new AbortController()
    setEnvironmentProviderSshAuthorizer(async () => ({
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted
    }))
    const connection = new SshConnection(target(), createCallbacks())
    await connection.connect()
    expect(connection.getState().status).toBe('connected')
    const end = vi.spyOn(connection.getClient()!, 'end')
    controller.abort()
    expect(connection.getState().status).toBe('disconnected')
    expect(end).toHaveBeenCalled()
    await expect(connection.exec('echo forbidden')).rejects.toThrow()
  })
  it('does not publish connected from a late handshake after withdrawal', async () => {
    const controller = new AbortController()
    setEnvironmentProviderSshAuthorizer(async () => ({
      signal: controller.signal,
      isCurrent: () => true
    }))
    const callbacks = createCallbacks()
    const connection = new SshConnection(target(), callbacks)
    const clientCreated = new Promise<void>((resolve) => {
      ssh2Mock.notifyClientCreated = resolve
    })
    const pending = connection.connect().catch((error: Error) => error)
    await clientCreated
    controller.abort()
    await expect(pending).resolves.toMatchObject({
      message: 'SSH connection attempt was cancelled'
    })
    expect(connection.getState().status).toBe('disconnected')
    expect(callbacks.onStateChange).not.toHaveBeenCalledWith(
      'target-1',
      expect.objectContaining({ status: 'connected' })
    )
  })
  it('never dials after disconnection during provider admission', async () => {
    const held = Promise.withResolvers<void>()
    const called = Promise.withResolvers<void>()
    setEnvironmentProviderSshAuthorizer(async () => {
      called.resolve()
      await held.promise
      return { signal: new AbortController().signal, isCurrent: () => true }
    })
    const connection = new SshConnection(target(), createCallbacks())
    const pending = connection.connect().catch((error: Error) => error)
    await called.promise
    await connection.disconnect()
    held.resolve()
    await expect(pending).resolves.toMatchObject({
      message: 'SSH connection attempt was cancelled'
    })
    expect(clientInstances).toHaveLength(0)
    expect(connection.getState().status).toBe('disconnected')
  })
})
