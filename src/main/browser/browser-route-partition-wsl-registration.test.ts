import { describe, expect, it } from 'vitest'
import { getPreferredPairedRuntimeConnection } from '../../shared/runtime-environments'
import { legacyBrowserNativeExecutionHostStorageIdentity } from './browser-execution-host-storage-identity'
import {
  createDesktop,
  openPage,
  orcaProfileId,
  seedLogin,
  seedPreW1Login,
  storageScopeOf
} from './browser-route-partition-re-pair-harness'
import { derivePairedRuntimeBrowserAuthorityIdentities } from './paired-runtime-browser-authority-identity'
import {
  pairedRuntimeHostEnvironment,
  WSL_DISTRO_ID_A,
  WSL_DISTRO_ID_B
} from './paired-runtime-browser-host-environment-fixture'

// Why: a re-imported (or exported and re-imported) distro can keep orcad's server key, so the key
// alone cannot tell two registrations apart; only a pairing made under the same GUID may hand
// over its jar.
describe('WSL browser jar adoption across registrations', () => {
  it('keeps the jar of a host whose GUID was captured when it was added', async () => {
    const desktop = createDesktop()
    const addedWithGuid = pairedRuntimeHostEnvironment({
      kind: 'wsl',
      pairingRevision: 1_000,
      pairedDeviceId: 'device-a'
    })
    const preW1Partition = seedPreW1Login(desktop, addedWithGuid)

    const opened = await openPage(desktop, addedWithGuid, 'runtime-a')

    expect(opened.partition).toBe(preW1Partition)
    expect(opened.readCookies()).toEqual(['session=signed-in'])
  })

  it.each([
    { case: 'the current pairing', revision: 1_000, previousPairings: undefined },
    {
      case: 'a replaced pairing that recorded the old GUID',
      revision: 2_000,
      previousPairings: [
        { pairingRevision: 1_000, pairedDeviceId: 'device-a', wslDistroId: WSL_DISTRO_ID_A }
      ]
    },
    {
      case: 'a replaced pairing that recorded none',
      revision: 2_000,
      previousPairings: [{ pairingRevision: 1_000, pairedDeviceId: 'device-a' }]
    }
  ])(
    'starts a fresh jar for a re-imported distro through $case',
    async ({ revision, previousPairings }) => {
      const desktop = createDesktop()
      const originalPartition = seedPreW1Login(
        desktop,
        pairedRuntimeHostEnvironment({
          kind: 'wsl',
          pairingRevision: 1_000,
          pairedDeviceId: 'device-a'
        })
      )
      const reImported = pairedRuntimeHostEnvironment({
        kind: 'wsl',
        distroId: WSL_DISTRO_ID_A,
        observedDistroId: WSL_DISTRO_ID_B,
        pairingRevision: revision,
        pairedDeviceId: revision === 1_000 ? 'device-a' : 'device-b',
        previousPairings
      })

      const opened = await openPage(desktop, reImported, 'runtime-b')

      expect(opened.partition).not.toBe(originalPartition)
      expect(opened.readCookies()).toEqual([])
    }
  )

  it.each([
    {
      case: 'the current pairing',
      environment: pairedRuntimeHostEnvironment({
        kind: 'wsl',
        distroId: null,
        observedDistroId: WSL_DISTRO_ID_A,
        pairingRevision: 1_000,
        pairedDeviceId: 'device-a'
      })
    },
    {
      case: 'a replaced pairing',
      environment: pairedRuntimeHostEnvironment({
        kind: 'wsl',
        distroId: null,
        observedDistroId: WSL_DISTRO_ID_A,
        pairingRevision: 2_000,
        pairedDeviceId: 'device-b',
        previousPairings: [{ pairingRevision: 1_000, pairedDeviceId: 'device-a' }]
      })
    }
  ])(
    'starts a fresh jar when the GUID is newly present and $case recorded none',
    async ({ environment }) => {
      const desktop = createDesktop()
      const madeWithoutGuid = pairedRuntimeHostEnvironment({
        kind: 'wsl',
        distroId: null,
        pairingRevision: 1_000,
        pairedDeviceId: 'device-a'
      })
      // Why: the fail-closed revision identity is what a GUID-less record's pages used.
      const withoutGuid = await openPage(desktop, madeWithoutGuid, 'runtime-a')
      withoutGuid.setCookie('session=signed-in')

      const opened = await openPage(desktop, environment, 'runtime-a')

      expect(opened.partition).not.toBe(withoutGuid.partition)
      expect(opened.readCookies()).toEqual([])
    }
  )

  it('applies the registration rule to every replaced pairing, not just the newest', async () => {
    const desktop = createDesktop()
    const foreignPartition = seedPreW1Login(
      desktop,
      pairedRuntimeHostEnvironment({
        kind: 'wsl',
        pairingRevision: 1_000,
        pairedDeviceId: 'device-a'
      })
    )
    const current = pairedRuntimeHostEnvironment({
      kind: 'wsl',
      distroId: WSL_DISTRO_ID_A,
      observedDistroId: WSL_DISTRO_ID_B,
      pairingWslDistroId: WSL_DISTRO_ID_B,
      pairingRevision: 4_000,
      pairedDeviceId: 'device-d',
      previousPairings: [
        { pairingRevision: 3_000, pairedDeviceId: 'device-c', wslDistroId: WSL_DISTRO_ID_B },
        { pairingRevision: 2_000, pairedDeviceId: 'device-b', wslDistroId: WSL_DISTRO_ID_B },
        { pairingRevision: 1_000, pairedDeviceId: 'device-a', wslDistroId: WSL_DISTRO_ID_A }
      ]
    })

    const opened = await openPage(desktop, current, 'runtime-d')

    expect(opened.partition).not.toBe(foreignPartition)
    expect(opened.readCookies()).toEqual([])
  })

  it('never adopts a runtimeId-era jar for a pairing made before the GUID was known', async () => {
    const desktop = createDesktop()
    const environment = pairedRuntimeHostEnvironment({
      kind: 'wsl',
      distroId: null,
      observedDistroId: WSL_DISTRO_ID_A,
      pairedDeviceId: 'device-a'
    })
    const runtimeScoped = derivePairedRuntimeBrowserAuthorityIdentities({
      orcaProfileId,
      environment: pairedRuntimeHostEnvironment({ kind: 'wsl', pairedDeviceId: 'device-a' }),
      connection: getPreferredPairedRuntimeConnection(environment),
      authorityRuntimeId: 'runtime-old',
      liveWslDistroId: WSL_DISTRO_ID_A
    }).legacyAuthorityConnectionIdentity
    if (runtimeScoped === null) {
      throw new Error('expected a runtimeId-era identity for a host added with its GUID')
    }
    const runtimeEraPartition = seedLogin(desktop, storageScopeOf(environment), {
      orcaProfileId,
      browserProfileId: 'default',
      authorityConnectionIdentity: runtimeScoped,
      executionHostIdentity: legacyBrowserNativeExecutionHostStorageIdentity('runtime-old')
    })

    const opened = await openPage(desktop, environment, 'runtime-old')

    expect(opened.partition).not.toBe(runtimeEraPartition)
    expect(opened.readCookies()).toEqual([])
  })
})

// Why: a recorded GUID may name a since-re-imported distro, so an unreadable registry must not
// lend it to the browser; the jar follows only what the registry confirms now.
describe('WSL browser jar when the registry read fails and recovers', () => {
  const host = pairedRuntimeHostEnvironment({
    kind: 'wsl',
    pairingRevision: 1_000,
    pairedDeviceId: 'device-a'
  })

  it('fails closed without adopting the confirmed jar', async () => {
    const desktop = createDesktop()
    const confirmed = await openPage(desktop, host, 'runtime-a', WSL_DISTRO_ID_A)
    confirmed.setCookie('session=signed-in')

    const unread = await openPage(desktop, host, 'runtime-a', null)

    expect(unread.partition).not.toBe(confirmed.partition)
    expect(unread.readCookies()).toEqual([])
    const reopened = await openPage(desktop, host, 'runtime-a', WSL_DISTRO_ID_A)
    expect(reopened.partition).toBe(confirmed.partition)
    expect(reopened.readCookies()).toEqual(['session=signed-in'])
  })

  it('returns to the confirmed jar once a read succeeds, leaving the fail-closed jar apart', async () => {
    const desktop = createDesktop()
    const confirmed = await openPage(desktop, host, 'runtime-a', WSL_DISTRO_ID_A)
    confirmed.setCookie('session=signed-in')
    const unread = await openPage(desktop, host, 'runtime-a', null)
    unread.setCookie('session=during-outage')

    const recovered = await openPage(desktop, host, 'runtime-a', WSL_DISTRO_ID_A)

    expect(recovered.partition).toBe(confirmed.partition)
    expect(recovered.readCookies()).toEqual(['session=signed-in'])
  })

  // Why adopt: the fail-closed jar is this pairing's, and the read now confirms the pairing's GUID.
  it('adopts the fail-closed jar when the first confirmed read comes after it', async () => {
    const desktop = createDesktop()
    const unread = await openPage(desktop, host, 'runtime-a', null)
    unread.setCookie('session=during-outage')

    const recovered = await openPage(desktop, host, 'runtime-a', WSL_DISTRO_ID_A)

    expect(recovered.partition).toBe(unread.partition)
    expect(recovered.readCookies()).toEqual(['session=during-outage'])
  })

  it('never adopts the fail-closed jar when the recovered read names another registration', async () => {
    const desktop = createDesktop()
    const unread = await openPage(desktop, host, 'runtime-a', null)
    unread.setCookie('session=during-outage')
    const reImported = pairedRuntimeHostEnvironment({
      kind: 'wsl',
      observedDistroId: WSL_DISTRO_ID_B,
      pairingRevision: 1_000,
      pairedDeviceId: 'device-a'
    })

    const recovered = await openPage(desktop, reImported, 'runtime-a', WSL_DISTRO_ID_B)

    expect(recovered.partition).not.toBe(unread.partition)
    expect(recovered.readCookies()).toEqual([])
  })
})
