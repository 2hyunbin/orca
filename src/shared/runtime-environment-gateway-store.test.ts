import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  createEnvironmentFromPairingOffer,
  KnownRuntimeEnvironmentSchema,
  getPreferredPairedRuntimeConnection
} from './runtime-environments'
import {
  readEnvironmentStore,
  readPersistedEnvironmentStore,
  writeEnvironmentStore
} from './runtime-environment-store-file'
import { resolveEnvironment } from './runtime-environment-store'
import { getEnvironmentStorePath } from './runtime-environment-store-records'
import { saveManagedGatewayEnvironment } from './runtime-environment-gateway-store'
import { runtimeGatewayHostKeyFingerprint } from './runtime-environment-gateway-overlay'
import { parseManagedWorkspaceGatewayCredential } from './managed-workspace-gateway-credential'
import { MANAGED_GATEWAY_INERT_TOKEN } from './runtime-environment-gateway-link'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-gateway-reference-'))
  directories.push(directory)
  const parent = createEnvironmentFromPairingOffer({
    id: 'controller',
    name: 'Company control host',
    now: 1,
    runtimeId: 'controller-process',
    offer: {
      v: 2,
      endpoint: 'wss://control.example',
      deviceToken: 'private-parent-token',
      publicKeyB64: 'parent-key'
    }
  })
  writeEnvironmentStore(directory, { version: 1, environments: [parent] })
  const descriptor = {
    version: 1 as const,
    controllerRuntimeId: 'controller-process',
    environmentId: 'managed-server',
    runtimeId: 'child-process',
    sshTargetId: 'ssh',
    targetGeneration: 1,
    name: 'Devbox',
    childHostKeyFingerprint: runtimeGatewayHostKeyFingerprint('child-key')
  }
  return { directory, parent, descriptor }
}
it('refuses treating a gateway reference as an independently managed SSH connection', () => {
  const f = fixture()
  const child = saveManagedGatewayEnvironment(f.directory, 'controller', f.descriptor)
  expect(
    KnownRuntimeEnvironmentSchema.safeParse({ ...child, connectionDependency: 'ssh-tunnel' })
      .success
  ).toBe(false)
})
it('stores only an inert reference and derives audience-bound credentials in memory', () => {
  const f = fixture()
  const child = saveManagedGatewayEnvironment(f.directory, 'controller', f.descriptor)
  expect(child.kind).toBe('managed-gateway')
  expect(child.gatewayConnectionBlocked).toBe(false)
  const pairing = getPreferredPairedRuntimeConnection(child)
  expect(pairing.endpoint).toBe('wss://control.example/_orca/managed/managed-server/1')
  expect(parseManagedWorkspaceGatewayCredential(pairing.credential.deviceToken)).toEqual({
    parentToken: 'private-parent-token',
    environmentId: 'managed-server',
    targetGeneration: 1
  })
  const persisted = readPersistedEnvironmentStore(f.directory).environments.find(
    (row) => row.id === child.id
  )
  expect(persisted?.endpoints[0].deviceToken).toBe(MANAGED_GATEWAY_INERT_TOKEN)
  expect(persisted?.endpoints[0].deviceToken).not.toBe(pairing.credential.deviceToken)
})
it('scrubs derived credentials even when a generic writer receives hydrated records', () => {
  const f = fixture()
  const child = saveManagedGatewayEnvironment(f.directory, 'controller', f.descriptor)
  const secret = getPreferredPairedRuntimeConnection(child).credential.deviceToken
  writeEnvironmentStore(f.directory, readEnvironmentStore(f.directory))
  expect(readFileSync(getEnvironmentStorePath(f.directory), 'utf8')).not.toContain(secret)
  expect(
    readPersistedEnvironmentStore(f.directory).environments.find((row) => row.id === child.id)
      ?.endpoints[0].deviceToken
  ).toBe(MANAGED_GATEWAY_INERT_TOKEN)
})
it.each(['revision', 'key', 'removed'])(
  'keeps the child inert when its controller is %s',
  (kind) => {
    const f = fixture()
    const child = saveManagedGatewayEnvironment(f.directory, 'controller', f.descriptor)
    const store = readPersistedEnvironmentStore(f.directory)
    writeEnvironmentStore(f.directory, {
      version: 1,
      environments: store.environments
        .filter((row) => kind !== 'removed' || row.id !== 'controller')
        .map((row) =>
          row.id === 'controller'
            ? {
                ...row,
                ...(kind === 'revision' ? { pairingRevision: 2 } : {}),
                ...(kind === 'key'
                  ? {
                      endpoints: row.endpoints.map((endpoint) => ({
                        ...endpoint,
                        publicKeyB64: 'different-key'
                      }))
                    }
                  : {})
              }
            : row
        )
    })
    const blocked = resolveEnvironment(f.directory, child.id)
    expect(blocked.gatewayConnectionBlocked).toBe(true)
    expect(() => getPreferredPairedRuntimeConnection(blocked)).toThrow('control host changed')
  }
)
it('refreshes a saved target without creating duplicate workspace identities', () => {
  const f = fixture()
  const first = saveManagedGatewayEnvironment(f.directory, 'controller', f.descriptor)
  const second = saveManagedGatewayEnvironment(f.directory, 'controller', {
    ...f.descriptor,
    targetGeneration: 2,
    runtimeId: 'new-child-process'
  })
  expect(second.id).toBe(first.id)
  expect(second.runtimeId).toBe('new-child-process')
  expect(readEnvironmentStore(f.directory).environments).toHaveLength(2)
  expect(getPreferredPairedRuntimeConnection(second).endpoint).toContain('/managed-server/2')
})
