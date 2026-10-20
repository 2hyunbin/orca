import { describe, expect, it } from 'vitest'
import { deriveBrowserRoutePartition } from './browser-route-identity'
import { BrowserRoutePartitionBindingStore } from './browser-route-partition-binding-store'
import {
  createDesktop,
  openPage,
  openPageLikePreW1Build,
  preW1RouteIdentity,
  seedPreW1Login
} from './browser-route-partition-re-pair-harness'
import {
  pairedRuntimeHostEnvironment,
  type PairedRuntimeHostKind
} from './paired-runtime-browser-host-environment-fixture'

function host(kind: PairedRuntimeHostKind, revision: number, device: string) {
  return pairedRuntimeHostEnvironment({ kind, pairingRevision: revision, pairedDeviceId: device })
}

describe('browser jars after a downgrade', () => {
  it.each(['managed-ssh', 'wsl'] as const)(
    'an older build opens the same %s jar the new build adopted, with no conflict',
    async (kind) => {
      const desktop = createDesktop()
      const environment = host(kind, 1_000, 'device-a')
      const preW1Partition = seedPreW1Login(desktop, environment)

      const adopted = await openPage(desktop, environment, 'runtime-a')
      adopted.setCookie('set-by-new-build=1')
      const downgraded = openPageLikePreW1Build(desktop, environment)

      expect(adopted.partition).toBe(preW1Partition)
      expect(downgraded).toBe(preW1Partition)
      expect(desktop.cookies.get(downgraded)).toEqual(['session=signed-in', 'set-by-new-build=1'])
      // The binding keeps the name older builds look up; the stable identity is an alias.
      const binding = new BrowserRoutePartitionBindingStore({
        filePath: desktop.bindingsPath
      })
        .listBindings()
        .get(preW1Partition)
      expect(binding?.fingerprint).toBe(
        deriveBrowserRoutePartition(preW1RouteIdentity(environment)).bindingFingerprint
      )
    }
  )

  it.each(['managed-ssh', 'wsl'] as const)(
    'the new build finds the %s jar again after an older build rewrote the binding file',
    async (kind) => {
      const desktop = createDesktop()
      const environment = host(kind, 1_000, 'device-a')
      const preW1Partition = seedPreW1Login(desktop, environment)
      await openPage(desktop, environment, 'runtime-a')

      // Why: an older build's rewrite keeps only the fields it knows, dropping the alias.
      openPageLikePreW1Build(desktop, environment)
      const reUpgraded = await openPage(desktop, environment, 'runtime-a')
      const afterRePair = await openPage(desktop, host(kind, 2_000, 'device-b'), 'runtime-b')

      expect(reUpgraded.partition).toBe(preW1Partition)
      expect(afterRePair.partition).toBe(preW1Partition)
      expect(afterRePair.readCookies()).toEqual(['session=signed-in'])
    }
  )

  it('an older build never conflicts on a jar the new build minted fresh', async () => {
    const desktop = createDesktop()
    const environment = host('managed-ssh', 1_000, 'device-a')
    const fresh = await openPage(desktop, environment, 'runtime-a')

    // Why: pre-W1 derives its own revision-scoped name, which the new build never holds.
    expect(() => openPageLikePreW1Build(desktop, environment)).not.toThrow()
    expect(openPageLikePreW1Build(desktop, environment)).not.toBe(fresh.partition)
  })
})
