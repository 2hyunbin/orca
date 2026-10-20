import { describe, expect, it } from 'vitest'
import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { legacyBrowserNativeExecutionHostStorageIdentity } from './browser-execution-host-storage-identity'
import { deriveBrowserRoutePartition } from './browser-route-identity'
import { BrowserRoutePartitionBindingStore } from './browser-route-partition-binding-store'
import {
  createDesktop,
  launchAndOpenPage,
  openPage,
  orcaProfileId,
  preW1RouteIdentity,
  seedLogin,
  seedPreW1Login,
  storageScopeOf
} from './browser-route-partition-re-pair-harness'
import { derivePairedRuntimeBrowserAuthorityIdentities } from './paired-runtime-browser-authority-identity'
import {
  pairedRuntimeHostEnvironment,
  WSL_DISTRO_ID_A,
  WSL_DISTRO_ID_B,
  type PairedRuntimeHostKind
} from './paired-runtime-browser-host-environment-fixture'

const browserProfileId = 'default'

function rotatingHost(
  kind: PairedRuntimeHostKind,
  revision: number,
  device: string
): KnownRuntimeEnvironment {
  return pairedRuntimeHostEnvironment({ kind, pairingRevision: revision, pairedDeviceId: device })
}

/** The registration a WSL pairing records it was made under. */
function madeUnder(kind: PairedRuntimeHostKind): { wslDistroId?: string } {
  return kind === 'wsl' ? { wslDistroId: WSL_DISTRO_ID_A } : {}
}

describe('browser logins across a managed host re-pair', () => {
  it.each([
    { kind: 'managed-ssh', rePair: 'an orcad update' },
    { kind: 'wsl', rePair: 'an orcad relaunch' }
  ] as const)('keeps an existing $kind user signed in through $rePair', async ({ kind }) => {
    const desktop = createDesktop()
    const atRevisionN = rotatingHost(kind, 1_000, 'device-a')
    const preW1Partition = seedPreW1Login(desktop, atRevisionN)

    const firstW1Launch = await launchAndOpenPage(desktop, atRevisionN, 'runtime-a')
    const rePaired = rotatingHost(kind, 2_000, 'device-b')
    const afterRePair = await launchAndOpenPage(desktop, rePaired, 'runtime-b')

    expect(firstW1Launch).toBe(preW1Partition)
    expect(afterRePair).toBe(preW1Partition)
    expect(desktop.cookies.get(afterRePair)).toEqual(['session=signed-in'])
    // The pre-W1 scheme would have moved the user to an empty jar here.
    expect(seedPreW1Login(createDesktop(), rePaired)).not.toBe(preW1Partition)
    const persisted = new BrowserRoutePartitionBindingStore({
      filePath: desktop.bindingsPath
    }).listBindings()
    expect([...persisted.keys()]).toEqual([preW1Partition])
  })

  // Why: the browser host starts lazily, so orcad can update and re-pair before any page opens.
  it.each(['managed-ssh', 'wsl'] as const)(
    'adopts the pre-upgrade jar of a %s host that re-paired before the first page opened',
    async (kind) => {
      const desktop = createDesktop()
      const preW1Partition = seedPreW1Login(desktop, rotatingHost(kind, 1_000, 'device-a'))
      const rePairedBeforeFirstPage = pairedRuntimeHostEnvironment({
        kind,
        pairingRevision: 2_000,
        pairedDeviceId: 'device-b',
        previousPairings: [
          { pairingRevision: 1_000, pairedDeviceId: 'device-a', ...madeUnder(kind) }
        ]
      })

      const partition = await launchAndOpenPage(desktop, rePairedBeforeFirstPage, 'runtime-b')
      const afterNextRePair = await launchAndOpenPage(
        desktop,
        pairedRuntimeHostEnvironment({
          kind,
          pairingRevision: 3_000,
          pairedDeviceId: 'device-c',
          previousPairings: [
            { pairingRevision: 2_000, pairedDeviceId: 'device-b', ...madeUnder(kind) }
          ]
        }),
        'runtime-c'
      )

      expect(partition).toBe(preW1Partition)
      expect(afterNextRePair).toBe(preW1Partition)
      expect(desktop.cookies.get(partition)).toEqual(['session=signed-in'])
    }
  )

  // Why: a key change is a different trust decision, so the replaced pairing's jar stays behind.
  it('never adopts the pre-upgrade jar across a server key change', async () => {
    const desktop = createDesktop()
    const preW1Partition = seedPreW1Login(desktop, rotatingHost('managed-ssh', 1_000, 'device-a'))
    const reKeyed = pairedRuntimeHostEnvironment({
      kind: 'managed-ssh',
      pairingRevision: 2_000,
      pairedDeviceId: 'device-b',
      publicKeyB64: 'host-key-b',
      previousPairings: [{ pairingRevision: 1_000, pairedDeviceId: 'device-a' }]
    })

    expect(await launchAndOpenPage(desktop, reKeyed, 'runtime-b')).not.toBe(preW1Partition)
  })

  // Why: an update then a rollback (or a WSL relaunch loop) can re-pair repeatedly before any page.
  it.each([
    { kind: 'managed-ssh', rePairs: 2 },
    { kind: 'managed-ssh', rePairs: 3 },
    { kind: 'wsl', rePairs: 2 },
    { kind: 'wsl', rePairs: 3 }
  ] as const)(
    'adopts the original jar of a $kind host after $rePairs re-pairs before first use',
    async ({ kind, rePairs }) => {
      const desktop = createDesktop()
      const preW1Partition = seedPreW1Login(desktop, rotatingHost(kind, 1_000, 'device-0'))
      // Most recent first, exactly as successive Orca-driven re-pairs record them.
      const replaced = Array.from({ length: rePairs }, (_, index) => ({
        pairingRevision: 1_000 * (rePairs - index),
        pairedDeviceId: `device-${rePairs - 1 - index}`,
        ...madeUnder(kind)
      }))
      const current = pairedRuntimeHostEnvironment({
        kind,
        pairingRevision: 1_000 * (rePairs + 1),
        pairedDeviceId: `device-${rePairs}`,
        previousPairings: replaced
      })

      const opened = await openPage(desktop, current, 'runtime-latest')

      expect(opened.partition).toBe(preW1Partition)
      expect(opened.readCookies()).toEqual(['session=signed-in'])
    }
  )

  it.each(['manual', 'plain-ssh'] as const)(
    'leaves a %s host on its pre-W1 partition',
    async (kind) => {
      const desktop = createDesktop()
      const environment = rotatingHost(kind, 1_000, 'device-a')
      const preW1Partition = seedPreW1Login(desktop, environment)

      expect(await launchAndOpenPage(desktop, environment, 'runtime-a')).toBe(preW1Partition)
      expect(await launchAndOpenPage(createDesktop(), environment, 'runtime-a')).toBe(
        preW1Partition
      )
    }
  )

  it('still adopts the runtimeId-scoped partition a much older build minted', async () => {
    const desktop = createDesktop()
    const environment = rotatingHost('managed-ssh', 1_000, 'device-a')
    const connection = getPreferredPairedRuntimeConnection(environment)
    const runtimeScoped = derivePairedRuntimeBrowserAuthorityIdentities({
      orcaProfileId,
      environment,
      connection,
      authorityRuntimeId: 'runtime-old'
    }).legacyAuthorityConnectionIdentity
    if (runtimeScoped === null) {
      throw new Error('managed SSH always keeps its runtimeId-era identity')
    }
    const oldPartition = seedLogin(desktop, storageScopeOf(environment), {
      orcaProfileId,
      browserProfileId,
      authorityConnectionIdentity: runtimeScoped,
      executionHostIdentity: legacyBrowserNativeExecutionHostStorageIdentity('runtime-old')
    })

    expect(await launchAndOpenPage(desktop, environment, 'runtime-old')).toBe(oldPartition)
    expect(
      await launchAndOpenPage(desktop, rotatingHost('managed-ssh', 2_000, 'device-b'), 'runtime-b')
    ).toBe(oldPartition)
  })

  // Why: a pre-W1 build already re-pointed the runtimeId-era name at its revision fingerprint.
  it('adopts a partition an earlier migration kept under its older name', async () => {
    const desktop = createDesktop()
    const environment = rotatingHost('wsl', 1_000, 'device-a')
    const storageScope = storageScopeOf(environment)
    const preW1Fingerprint = deriveBrowserRoutePartition(
      preW1RouteIdentity(environment)
    ).bindingFingerprint
    const runtimeEraName = `persist:orca-browser-v1-${'a'.repeat(64)}`
    new BrowserRoutePartitionBindingStore({ filePath: desktop.bindingsPath }).set(
      runtimeEraName,
      preW1Fingerprint,
      storageScope
    )

    expect(await launchAndOpenPage(desktop, environment, 'runtime-a')).toBe(runtimeEraName)
  })

  it('reclaims the partition when a stale sidecar hides the managed deployment', async () => {
    const desktop = createDesktop()
    const managed = rotatingHost('managed-ssh', 1_000, 'device-a')
    const adopted = await launchAndOpenPage(desktop, managed, 'runtime-a')
    const unlinked = pairedRuntimeHostEnvironment({
      kind: 'plain-ssh',
      id: managed.id,
      pairingRevision: 1_000,
      pairedDeviceId: 'device-a'
    })

    expect(await launchAndOpenPage(desktop, unlinked, 'runtime-a')).toBe(adopted)
    expect(await launchAndOpenPage(desktop, managed, 'runtime-a')).toBe(adopted)
  })
})

describe('browser partitions stay per host', () => {
  it('fails closed for a WSL host without a registration GUID', async () => {
    const desktop = createDesktop()
    const environment = pairedRuntimeHostEnvironment({
      kind: 'wsl',
      distroId: null,
      pairingRevision: 1_000,
      pairedDeviceId: 'device-a'
    })
    const preW1Partition = seedPreW1Login(desktop, environment)

    expect(await launchAndOpenPage(desktop, environment, 'runtime-a')).toBe(preW1Partition)
    const rePaired = pairedRuntimeHostEnvironment({
      kind: 'wsl',
      distroId: null,
      pairingRevision: 2_000,
      pairedDeviceId: 'device-b'
    })
    expect(await launchAndOpenPage(desktop, rePaired, 'runtime-b')).not.toBe(preW1Partition)
  })

  it('never hands a re-imported distro the previous registration’s logins', async () => {
    const desktop = createDesktop()
    const original = rotatingHost('wsl', 1_000, 'device-a')
    const signedIn = await launchAndOpenPage(desktop, original, 'runtime-a')
    desktop.cookies.set(signedIn, ['session=signed-in'])
    const reImported = pairedRuntimeHostEnvironment({
      kind: 'wsl',
      distroId: WSL_DISTRO_ID_B,
      pairingRevision: 2_000,
      pairedDeviceId: 'device-b'
    })

    const partition = await launchAndOpenPage(desktop, reImported, 'runtime-b')

    expect(partition).not.toBe(signedIn)
    expect(desktop.cookies.get(partition)).toBeUndefined()
  })

  it('gives distinct environments and server keys distinct partitions', async () => {
    const desktop = createDesktop()
    const partitions = [
      await launchAndOpenPage(desktop, rotatingHost('managed-ssh', 1_000, 'device-a'), 'r'),
      await launchAndOpenPage(
        desktop,
        pairedRuntimeHostEnvironment({ kind: 'managed-ssh', id: 'environment-b' }),
        'r'
      ),
      await launchAndOpenPage(
        desktop,
        pairedRuntimeHostEnvironment({ kind: 'managed-ssh', publicKeyB64: 'host-key-b' }),
        'r'
      ),
      await launchAndOpenPage(desktop, rotatingHost('wsl', 1_000, 'device-a'), 'r')
    ]

    expect(new Set(partitions).size).toBe(partitions.length)
  })
})
