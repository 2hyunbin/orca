import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { beforeAll, describe, expect, it } from 'vitest'
import { DeviceRegistry, type DeviceEntry } from '../../../src/main/runtime/device-registry'
import { DEVICE_REGISTRY_FILENAME } from '../../../src/main/runtime/mobile-pairing-files'
import { DEVICE_KEY_EPHEMERAL_RUNTIME_CAPABILITY } from '../../../src/shared/device-key-capability'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'

const SUITE_TIMEOUT_MS = 180_000
// The parent of session-only support preserves the downgrade boundary as releases advance.
const BEFORE_SESSION_ONLY_REF = '79a597375b858f517495bf5a745ed595d0491c97'

type RegistryLike = {
  validateToken(token: string): { deviceId: string } | null
  updateLastSeen(deviceId: string): void
}

type RegistryBuild = {
  Registry: new (userDataPath: string) => RegistryLike
  capabilities: readonly string[]
}

async function loadRegistry(ref: string): Promise<RegistryBuild> {
  const checkout = await materializeReleaseCheckout(ref)
  const [registryModule, protocolModule] = await Promise.all([
    importReleaseCheckoutModule(checkout, 'src/main/runtime/device-registry.ts'),
    importReleaseCheckoutModule(checkout, 'src/shared/protocol-version.ts')
  ])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the source build's DeviceRegistry export; registry behavior is asserted below.
  const Registry = registryModule.DeviceRegistry as RegistryBuild['Registry']
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the source build's capability export; its registry policy is asserted below.
  const capabilities = protocolModule.RUNTIME_CAPABILITIES as readonly string[]
  return { Registry, capabilities }
}

let predecessor: RegistryBuild
let latest: RegistryBuild

beforeAll(async () => {
  ;[predecessor, latest] = await Promise.all([
    loadRegistry(BEFORE_SESSION_ONLY_REF),
    loadRegistry(resolveBaselineReleaseRef())
  ])
}, SUITE_TIMEOUT_MS)

describe('cross-version: session-only browser rows', () => {
  it('the predecessor never invites a browser to send ephemeral', () => {
    expect(predecessor.capabilities).not.toContain(DEVICE_KEY_EPHEMERAL_RUNTIME_CAPABILITY)
  })

  it.each(['predecessor', 'latest'] as const)(
    '%s retains token access and follows its advertised session policy',
    (version) => {
      const build = version === 'predecessor' ? predecessor : latest
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-xv-web-session-'))
      const current = new DeviceRegistry(userDataPath)
      const legacy = current.addDevice('Browser', 'runtime')
      current.updateLastSeen(legacy.deviceId)
      const keyB64 = Buffer.from(nacl.sign.keyPair().publicKey).toString('base64')
      const session = current.forkDeviceKey(legacy.deviceId, keyB64, 'Tab', { ephemeral: true })

      try {
        const released = new build.Registry(userDataPath)
        expect(released.validateToken(legacy.token)?.deviceId).toBe(legacy.deviceId)
        released.updateLastSeen(legacy.deviceId)
        const rows: DeviceEntry[] = JSON.parse(
          readFileSync(join(userDataPath, DEVICE_REGISTRY_FILENAME), 'utf8')
        )
        if (build.capabilities.includes(DEVICE_KEY_EPHEMERAL_RUNTIME_CAPABILITY)) {
          expect(rows.find((row) => row.deviceId === session.deviceId)).toBeUndefined()
        } else {
          expect(rows.find((row) => row.deviceId === session.deviceId)).toMatchObject({
            ephemeral: true,
            devicePublicKeyB64: keyB64
          })
        }
        expect(rows.find((row) => row.deviceId === session.deviceId)?.token).toBeUndefined()

        const restarted = new DeviceRegistry(userDataPath)
        expect(restarted.getDevice(session.deviceId)).toBeNull()
        expect(restarted.validateToken(legacy.token)?.deviceId).toBe(legacy.deviceId)
      } finally {
        rmSync(userDataPath, { recursive: true, force: true })
      }
    }
  )
})
