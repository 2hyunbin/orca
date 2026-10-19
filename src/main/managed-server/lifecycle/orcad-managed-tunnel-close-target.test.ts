import { describe, expect, it, vi } from 'vitest'
import {
  createEnvironmentFromPairingOffer,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import { PAIRING_OFFER_VERSION } from '../../../shared/pairing'
import type { SshTarget } from '../../../shared/ssh-types'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import type { SshConnectionManager } from '../../ssh/connection/ssh-connection-manager'
import type { SshConnectionStore } from '../../ssh/connection/ssh-connection-store'
import { SshPortForwardManager } from '../../ssh/port-forwarding/ssh-port-forward'
import type {
  PortForwardStartOptions,
  SshPortForwardProvider
} from '../../ssh/port-forwarding/ssh-port-forward-provider'
import { OrcadManagedTunnelManager } from './orcad-managed-tunnel-manager'

function createEnvironment(): KnownRuntimeEnvironment {
  const paired = createEnvironmentFromPairingOffer({
    id: 'environment-1',
    name: 'Managed server',
    now: 1,
    offer: {
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://127.0.0.1:46768',
      deviceToken: 'device-token',
      publicKeyB64: 'public-key'
    },
    connectionDependency: 'ssh-tunnel'
  })
  return {
    ...paired,
    orcadDeployment: {
      sshTargetId: 'ssh-1',
      sshTargetGeneration: 7,
      localPort: 46_768,
      remotePort: 6_768
    }
  }
}

/** A real forward manager over a provider whose forwards stay "listening" until closed. */
function setup() {
  const target: SshTarget = {
    id: 'ssh-1',
    label: 'Managed server',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    generation: 7,
    orcadFence: { environmentId: 'environment-1' }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double for the members the tunnel manager calls.
  const connection = { getConnectGeneration: () => 3 } as unknown as SshConnection
  const listening = new Set<string>()
  const provider: SshPortForwardProvider = {
    canHandle: () => true,
    start: async (_conn: SshConnection, options: PortForwardStartOptions) => {
      listening.add(options.id)
      const entry = {
        id: options.id,
        connectionId: options.connectionId,
        localPort: options.localPort,
        remoteHost: options.remoteHost,
        remotePort: options.remotePort
      }
      return {
        entry,
        close: async () => {
          listening.delete(options.id)
        },
        dispose: () => {
          listening.delete(options.id)
        }
      }
    }
  }
  const connect = vi.fn().mockResolvedValue(connection)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double for the members the tunnel manager calls.
  const connectionManager = { connect } as unknown as SshConnectionManager
  const manager = new OrcadManagedTunnelManager({
    getConnectionManager: () => connectionManager,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tunnel manager reads only getTarget.
    getTargetStore: () => ({ getTarget: () => target }) as unknown as SshConnectionStore,
    forwardManager: new SshPortForwardManager({}, [provider])
  })
  return { connect, connection, listening, manager }
}

describe('OrcadManagedTunnelManager.closeTarget (the SSH session teardown)', () => {
  it("closes the host's built tunnel, so nothing keeps listening after Disconnect", async () => {
    const state = setup()
    const environment = createEnvironment()
    await state.manager.ensure(environment)
    expect(state.listening.size).toBe(1)

    await state.manager.closeTarget('ssh-1')

    expect(state.listening.size).toBe(0)
  })

  it('leaves the tunnels of other hosts alone', async () => {
    const state = setup()
    await state.manager.ensure(createEnvironment())

    await state.manager.closeTarget('ssh-2')

    expect(state.listening.size).toBe(1)
  })

  it('supersedes a build still dialling, so it opens no forward after the teardown', async () => {
    const state = setup()
    let finishConnect: (connection: SshConnection) => void = () => {}
    state.connect.mockReturnValueOnce(
      new Promise<SshConnection>((resolve) => {
        finishConnect = resolve
      })
    )
    const build = state.manager.ensure(createEnvironment(), undefined, false)
    await vi.waitFor(() => expect(state.connect).toHaveBeenCalled())

    await state.manager.closeTarget('ssh-1')
    finishConnect(state.connection)

    await expect(build).rejects.toThrow('superseded')
    expect(state.listening.size).toBe(0)
  })
})
