import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, type Server, type Socket } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer, parsePairingCode, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import type { ServeReadiness } from '../server/serve-readiness'
import { OrcadManagedIdentityError } from '../ssh/orcad-managed-tunnel-identity'
import { checkOrcadStdioBridge, openOrcadStdioBridgeChannel } from '../ssh/orcad-stdio-bridge'
import { startEchoServer } from '../ssh/orcad-stdio-bridge-test-channel'
import { fakeWslBridgeChildren, posixOrcadStdioBridge } from './wsl-orcad-bridge-test-child'
import {
  WslOrcadConnectionManager,
  WslOrcadConnectionSupersededError,
  WslOrcadLaunchDeferredError,
  type WslOrcadConnection,
  type WslOrcadConnectionDependencies
} from './wsl-orcad-connection'
import type { WslOrcadLaunch } from './wsl-orcad-deploy'
import { createWslOrcadHostTransport } from './wsl-orcad-host-transport'
import { listenWslOrcadStdioBridge } from './wsl-orcad-stdio-bridge'
import { wslOrcadHostDistro } from './wsl-orcad-host-environments'
import { WslHostService } from './wsl-host-service'
import {
  addWslHostEnvironment,
  findWslHostDeployment
} from '../../shared/runtime-environment-wsl-host-store'
import { listEnvironments } from '../../shared/runtime-environment-store'
import * as environmentStore from '../../shared/runtime-environment-store-file'
import { publicRuntimeEnvironmentWithHostKey } from '../ipc/runtime-environment-host-key'
import { runtimeEnvironmentRevisionFailure } from '../ipc/runtime-environment-revision-guard'
import {
  classifyPeerReplacements,
  replacedRuntimeEnvironmentIds
} from '../../renderer/src/store/slices/runtime-environment-peer-replacement'

let first: { server: Server; port: number }
let second: { server: Server; port: number }
const managers: WslOrcadConnectionManager[] = []
const clients: Socket[] = []

beforeAll(async () => {
  first = await startEchoServer()
  second = await startEchoServer()
})

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.destroy()
  }
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()))
})

afterAll(() => {
  first.server.close()
  second.server.close()
})

function readiness(port: number, deviceToken = 'device-token'): ServeReadiness {
  const endpoint = `ws://127.0.0.1:${port}`
  return {
    runtimeId: 'runtime-1',
    boundEndpoint: endpoint,
    advertisedEndpoint: null,
    managedWslCliReconciliation: 'settled',
    pairing: {
      available: true,
      url: encodePairingOffer({
        v: PAIRING_OFFER_VERSION,
        endpoint,
        deviceToken,
        publicKeyB64: 'public-key',
        pairedDeviceId: 'device-1'
      }),
      endpoint,
      deviceId: 'device-1',
      webClientUrl: null,
      scope: 'runtime',
      qr: null
    }
  }
}

function ready(port: number, deviceToken?: string): Extract<WslOrcadLaunch, { outcome: 'ready' }> {
  return {
    outcome: 'ready',
    distro: 'Ubuntu',
    distroId: '00000000-0000-4000-8000-000000000001',
    port,
    fullVersion: '1.0.0',
    pid: 42,
    readiness: readiness(port, deviceToken),
    holder: 'adopted'
  }
}

function setup(overrides: Partial<WslOrcadConnectionDependencies> = {}) {
  const children = fakeWslBridgeChildren()
  const launches: WslOrcadLaunch[] = []
  const deployAndLaunch = vi.fn(async () => launches.shift() ?? ready(first.port))
  const onChange = vi.fn()
  const manager = new WslOrcadConnectionManager({
    deployAndLaunch,
    createTransport: (target) => createWslOrcadHostTransport({ target, spawn: children.spawn }),
    listen: (transport, options) =>
      listenWslOrcadStdioBridge(transport, options, {
        resolveBridge: async (_conn, port) => posixOrcadStdioBridge(port),
        checkBridge: checkOrcadStdioBridge,
        openChannel: openOrcadStdioBridgeChannel
      }),
    verifyIdentity: async () => ({ verdict: 'verified' }),
    onChange,
    ...overrides
  })
  managers.push(manager)
  return { manager, children, launches, deployAndLaunch, onChange }
}

function dial(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => resolve(socket))
    socket.once('error', reject)
    clients.push(socket)
  })
}

function echoOf(socket: Socket, message: string): Promise<string> {
  return new Promise((resolve) => {
    let received = ''
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8')
      if (received.length >= message.length) {
        resolve(received)
      }
    })
    socket.write(message)
  })
}

async function roundTrip(connection: WslOrcadConnection, message: string): Promise<string> {
  return echoOf(await dial(connection.localPort), message)
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(condition()).toBe(true)
}

describe('WslOrcadConnectionManager', () => {
  it('rewrites the pairing offer to the local bridge port and nothing else', async () => {
    const { manager, onChange } = setup()
    const connection = await manager.ensure('Ubuntu')

    expect(connection).toMatchObject({
      distro: 'Ubuntu',
      environmentId: 'wsl:ubuntu',
      remotePort: first.port,
      fullVersion: '1.0.0'
    })
    expect(connection.localPort).not.toBe(first.port)
    expect(parsePairingCode(connection.pairingOffer)).toEqual({
      v: PAIRING_OFFER_VERSION,
      endpoint: `ws://127.0.0.1:${connection.localPort}/`,
      deviceToken: 'device-token',
      publicKeyB64: 'public-key',
      pairedDeviceId: 'device-1'
    })
    expect(onChange.mock.calls).toEqual([
      ['Ubuntu', null, { state: 'connecting' }, 'status'],
      ['Ubuntu', connection, { state: 'ready', census: null }]
    ])
    expect(connection.pid).toBe(42)
    expect(await roundTrip(connection, 'hello')).toBe('hello')
  })

  it('publishes observed installation changes through catalog retirement, even with the same pairing', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'wsl-installation-'))
    const g1 = '00000000-0000-4000-8000-000000000001'
    const g2 = '00000000-0000-4000-8000-000000000002'
    const invalidated = vi.fn()
    const hostReady = vi.fn()
    const service = new WslHostService({
      userDataPath: () => profile,
      isEnabled: () => true,
      hasServerFiles: () => true,
      publish: vi.fn(), pairingChanged: invalidated, ready: hostReady, removed: vi.fn()
    })
    const { manager, launches } = setup({ onChange: service.handleConnectionChange.bind(service) })
    try {
      launches.push({ ...ready(first.port), distroId: g1 })
      const firstConnection = await manager.ensure('Ubuntu')
      addWslHostEnvironment(profile, {
        id: 'wsl:ubuntu',
        name: 'Ubuntu',
        pairingCode: firstConnection.pairingOffer,
        record: {
          kind: 'wsl', distro: 'Ubuntu', distroId: firstConnection.distroId ?? undefined,
          localPort: firstConnection.localPort, remotePort: first.port
        }
      })
      const enrolled = listEnvironments(profile).map(publicRuntimeEnvironmentWithHostKey)
      launches.push({ ...ready(first.port), distroId: g2 })
      const refreshed = await manager.ensure('Ubuntu')
      const [environment] = listEnvironments(profile)
      const after = [publicRuntimeEnvironmentWithHostKey(environment)]
      expect(refreshed.pairingOffer).toBe(firstConnection.pairingOffer)
      expect(environment.orcadDeployment).toMatchObject({ distroId: g2 })
      expect(invalidated).toHaveBeenCalledWith('wsl:ubuntu')
      expect(classifyPeerReplacements(enrolled, after, replacedRuntimeEnvironmentIds(enrolled, after)))
        .toEqual({ retired: ['wsl:ubuntu'], sameHost: [] })
      const before = listEnvironments(profile).map(publicRuntimeEnvironmentWithHostKey)
      const fail = vi.spyOn(environmentStore, 'writeEnvironmentStore').mockImplementationOnce(() => {
        throw new Error('disk full')
      })
      launches.push({ ...ready(first.port), distroId: null })
      await expect(manager.ensure('Ubuntu')).rejects.toThrow('disk full')
      fail.mockRestore()
      expect(manager.get('Ubuntu')).toBeNull()
      const partial = listEnvironments(profile).map(publicRuntimeEnvironmentWithHostKey)
      expect(partial[0].orcadDeployment).toMatchObject({ kind: 'wsl' })
      expect(findWslHostDeployment(profile, 'wsl:ubuntu')?.distroId).toBeUndefined()
      expect(
        classifyPeerReplacements(before, partial, replacedRuntimeEnvironmentIds(before, partial))
      ).toEqual({ retired: ['wsl:ubuntu'], sameHost: [] })
      launches.push({ ...ready(first.port), distroId: null })
      await manager.ensure('Ubuntu', {
        localPort: firstConnection.localPort,
        status: { pending: { state: 'connecting' }, ready: {
          state: 'reconnecting', reason: 'census', attempt: 1,
          retryInMs: null, terminals: 'unverifiable'
        } }
      })
      expect(
        runtimeEnvironmentRevisionFailure(listEnvironments(profile)[0], before[0].pairingRevision, 'test')
      ).toMatchObject({ ok: false })
      const revision = listEnvironments(profile)[0].pairingRevision
      hostReady.mockClear()
      manager.publish('Ubuntu', { state: 'ready', census: null })
      expect(hostReady).toHaveBeenCalledWith('wsl:ubuntu')
      expect(listEnvironments(profile)[0].pairingRevision).toBe(revision)
      launches.push({ ...ready(first.port), distroId: null })
      await manager.ensure('Ubuntu')
      expect(listEnvironments(profile)[0].pairingRevision).toBeGreaterThan(revision ?? 0)
    } finally {
      vi.restoreAllMocks()
      await manager.dispose()
      rmSync(profile, { recursive: true, force: true })
    }
  })

  it('shares one deploy and one bridge between concurrent connects to a distro', async () => {
    const { manager, deployAndLaunch, children } = setup()
    const [a, b] = await Promise.all([manager.ensure('Ubuntu'), manager.ensure('ubuntu ')])
    expect(a).toBe(b)
    expect(deployAndLaunch).toHaveBeenCalledTimes(1)
    expect(manager.list()).toEqual([a])
    expect(manager.get('UBUNTU')).toBe(a)
    // Only the bridge check ran a child so far.
    expect(children.commands).toHaveLength(1)
  })

  it('keeps the bridge when orcad still listens on the same port', async () => {
    const { manager, children, launches, onChange } = setup()
    const connection = await manager.ensure('Ubuntu')
    launches.push(ready(first.port))
    expect(await manager.ensure('Ubuntu')).toBe(connection)
    expect(children.commands).toHaveLength(1)
    // A refresh that changed nothing stays quiet: connecting, ready, and no more.
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('keeps its client grant when a relaunch advertises a new pairing offer', async () => {
    const { manager, launches, onChange } = setup()
    const connection = await manager.ensure('Ubuntu')
    launches.push(ready(first.port, 'rotated-token'))
    const refreshed = await manager.ensure('Ubuntu')
    expect(refreshed.localPort).toBe(connection.localPort)
    expect(refreshed.pairingOffer).toBe(connection.pairingOffer)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('moves the bridge to the new port after a relaunch, on the same local port', async () => {
    const { manager, launches, children } = setup()
    const before = await manager.ensure('Ubuntu')
    const stale = await dial(before.localPort)
    expect(await echoOf(stale, 'old')).toBe('old')
    const staleClosed = new Promise((resolve) => stale.once('close', resolve))

    launches.push(ready(second.port))
    const after = await manager.ensure('Ubuntu')
    expect(after).not.toBe(before)
    expect(after.remotePort).toBe(second.port)
    expect(after.localPort).toBe(before.localPort)
    expect(after.pairingOffer).toBe(before.pairingOffer)
    await staleClosed
    expect(await roundTrip(after, 'new')).toBe('new')
    expect(children.commands.at(-1)).toContain(` ${second.port}; fi; done;`)
  })

  it('serves the incumbent with its deferred update, then reports the update landing', async () => {
    const { manager, launches, onChange, deployAndLaunch } = setup()
    const deferredUpdate = {
      candidateVersion: '2.0.0',
      code: 'orcad_update_terminals_running',
      reason: 'Terminals are running.',
      forceable: true
    }
    launches.push({ ...ready(first.port), deferredUpdate })
    const incumbent = await manager.ensure('Ubuntu')
    expect(incumbent.deferredUpdate).toEqual(deferredUpdate)
    launches.push({ ...ready(first.port), fullVersion: '2.0.0' })
    const updated = await manager.ensure('Ubuntu', { force: true })
    expect(deployAndLaunch).toHaveBeenLastCalledWith(
      'Ubuntu',
      expect.objectContaining({ force: true })
    )
    expect(updated).toMatchObject({
      fullVersion: '2.0.0',
      deferredUpdate: null
    })
    expect(onChange).toHaveBeenLastCalledWith('Ubuntu', updated, {
      state: 'ready',
      census: null
    })
  })

  it('runs a forced connect after a plain one in flight instead of joining it', async () => {
    const { manager, deployAndLaunch } = setup()
    const plain = manager.ensure('Ubuntu')
    const forced = manager.ensure('Ubuntu', { force: true })
    await Promise.all([plain, forced])
    expect(deployAndLaunch).toHaveBeenCalledTimes(2)
    expect(deployAndLaunch).toHaveBeenLastCalledWith(
      'Ubuntu',
      expect.objectContaining({ force: true })
    )
  })

  it('drops a queued forced connect that a close overtook', async () => {
    const { manager, deployAndLaunch } = setup()
    const plain = manager.ensure('Ubuntu')
    const forced = manager.ensure('Ubuntu', { force: true })
    await manager.close('Ubuntu')
    await plain.catch(() => {})
    await expect(forced).rejects.toBeInstanceOf(WslOrcadConnectionSupersededError)
    expect(deployAndLaunch).toHaveBeenCalledTimes(1)
  })

  it('throws the deferral and starts no bridge', async () => {
    const { manager, launches, children } = setup()
    launches.push({
      outcome: 'deferred',
      distro: 'Ubuntu',
      candidateVersion: '2.0.0',
      code: 'live_terminals',
      reason: 'Terminals are running.',
      forceable: true
    })
    await expect(manager.ensure('Ubuntu')).rejects.toBeInstanceOf(WslOrcadLaunchDeferredError)
    expect(children.commands).toHaveLength(0)
    expect(manager.get('Ubuntu')).toBeNull()
  })

  it('refuses a foreign server behind the port and closes its bridge', async () => {
    const { manager, children, onChange } = setup({
      verifyIdentity: async () => ({ verdict: 'foreign', detail: 'another runtime' })
    })
    await expect(manager.ensure('Ubuntu')).rejects.toBeInstanceOf(OrcadManagedIdentityError)
    expect(manager.get('Ubuntu')).toBeNull()
    expect(onChange).toHaveBeenLastCalledWith(
      'Ubuntu',
      null,
      expect.objectContaining({ state: 'failed', terminals: 'unverifiable' }),
      'status'
    )
    await until(() => children.live() === 0)
  })

  it('reports the caller-supplied statuses for a liveness reconnect, even when nothing changed', async () => {
    const { manager, launches, onChange } = setup()
    const connection = await manager.ensure('Ubuntu')
    launches.push(ready(first.port))
    const pending = {
      state: 'reconnecting',
      reason: 'orcad-exited',
      attempt: 1,
      retryInMs: null,
      terminals: 'unverifiable'
    } as const
    const census = { ...pending, reason: 'census' } as const
    await manager.ensure('Ubuntu', { status: { pending, ready: census } })
    expect(onChange.mock.calls.slice(-2)).toEqual([
      ['Ubuntu', connection, pending, 'status'],
      ['Ubuntu', connection, census]
    ])
    manager.publish('Ubuntu', { state: 'ready', census: null })
    expect(onChange).toHaveBeenLastCalledWith(
      'Ubuntu', connection, { state: 'ready', census: null }, 'status'
    )
  })

  it('drops a connect that a close overtook', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { manager } = setup({
      deployAndLaunch: async () => {
        await gate
        return ready(first.port)
      }
    })
    const pending = manager.ensure('Ubuntu')
    await manager.close('Ubuntu')
    release()
    await expect(pending).rejects.toBeInstanceOf(WslOrcadConnectionSupersededError)
    expect(manager.get('Ubuntu')).toBeNull()
  })

  it('tears down every bridge child and the listener on close', async () => {
    const { manager, children, onChange } = setup()
    const connection = await manager.ensure('Ubuntu')
    const sockets = await Promise.all([1, 2, 3].map(() => dial(connection.localPort)))
    await Promise.all(sockets.map((socket, i) => echoOf(socket, `s${i}`)))
    expect(children.live()).toBe(3)

    await connection.close()
    await until(() => children.live() === 0)
    expect(manager.get('Ubuntu')).toBeNull()
    expect(onChange).toHaveBeenLastCalledWith('Ubuntu', null, { state: 'closed' }, 'status')
    await expect(dial(connection.localPort)).rejects.toThrow()
  })

  it('lists its environment as a WSL host only while the connection is open', async () => {
    const { manager } = setup()
    const connection = await manager.ensure('Ubuntu')
    expect(wslOrcadHostDistro(connection.environmentId)).toBe('Ubuntu')
    await connection.close()
    expect(wslOrcadHostDistro(connection.environmentId)).toBeNull()
  })
})
