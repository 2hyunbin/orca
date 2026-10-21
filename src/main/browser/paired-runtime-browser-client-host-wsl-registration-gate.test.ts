import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import {
  addWslHostEnvironment,
  findWslHostDeployment
} from '../../shared/runtime-environment-wsl-host-store'
import { getPreferredPairedRuntimeConnection } from '../../shared/runtime-environments'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() }
}))

vi.mock('./paired-runtime-browser-client-host-composition', () => ({
  PairedRuntimeBrowserClientHostComposition: class {
    start(): Promise<unknown> {
      return Promise.resolve({ authority: 'lease-a' })
    }

    replaceAuthority(): Promise<unknown> {
      return Promise.resolve({ authority: 'lease-a' })
    }

    close(): Promise<boolean> {
      return Promise.resolve(true)
    }

    whenClosed(): Promise<void> {
      return Promise.resolve()
    }
  }
}))

import {
  observeWslHostRegistration,
  resetWslHostRegistrationReadsForTests,
  WSL_HOST_REGISTRATION_WAIT_MS
} from '../wsl/wsl-host-connection-record'
import { derivePairedRuntimeBrowserAuthorityIdentities } from './paired-runtime-browser-authority-identity'
import {
  configurePairedRuntimeBrowserClientHostsForOrcaProfile,
  getPairedRuntimeBrowserClientRouteIdentity,
  closePairedRuntimeBrowserClientHostEnvironment,
  startPairedRuntimeBrowserClientHost
} from './paired-runtime-browser-client-host-runtime'
import { WSL_DISTRO_ID_A } from './paired-runtime-browser-host-environment-fixture'

const environmentId = 'wsl:ubuntu'
const orcaProfileId = 'profile-a'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(e: Error): void } {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('WSL browser host start waits for the registration read', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-browser-gate-'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    configurePairedRuntimeBrowserClientHostsForOrcaProfile({ orcaProfileId })
    // Why: added without its GUID, so only the registry read can supply it.
    addWslHostEnvironment(userDataPath, {
      id: environmentId,
      name: 'Ubuntu (WSL)',
      pairingCode: encodePairingOffer({
        v: 2,
        endpoint: 'ws://127.0.0.1:42000',
        deviceToken: 'token-1',
        publicKeyB64: Buffer.alloc(32, 7).toString('base64')
      }),
      record: { kind: 'wsl', distro: 'Ubuntu', localPort: 42000, remotePort: 6768 }
    })
  })
  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    resetWslHostRegistrationReadsForTests()
    await closePairedRuntimeBrowserClientHostEnvironment(environmentId)
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function expectedIdentity(liveWslDistroId: string | null): string {
    const environment = resolveEnvironment(userDataPath, environmentId)
    return derivePairedRuntimeBrowserAuthorityIdentities({
      orcaProfileId,
      environment,
      connection: getPreferredPairedRuntimeConnection(environment),
      authorityRuntimeId: 'runtime-a',
      liveWslDistroId
    }).authorityConnectionIdentity
  }

  function startBrowserHost(): Promise<unknown> {
    return startPairedRuntimeBrowserClientHost({
      environment: resolveEnvironment(userDataPath, environmentId),
      authorityRuntimeId: 'runtime-a',
      userDataPath
    })
  }

  function startedIdentity(): string | undefined {
    return getPairedRuntimeBrowserClientRouteIdentity(environmentId)?.authorityConnectionIdentity
  }

  it('waits for the read its connection started, then derives from the GUID it recorded', async () => {
    const read = deferred<string | null>()
    void observeWslHostRegistration(
      userDataPath,
      { environmentId, distro: 'Ubuntu' },
      () => read.promise
    )

    const starting = startBrowserHost()
    await Promise.resolve()
    expect(startedIdentity()).toBeUndefined()
    read.resolve(WSL_DISTRO_ID_A)
    await starting

    expect(startedIdentity()).toBe(expectedIdentity(WSL_DISTRO_ID_A))
    expect(startedIdentity()).not.toBe(expectedIdentity(null))
  })

  it('fails closed when the read in flight fails', async () => {
    const read = deferred<string | null>()
    void observeWslHostRegistration(
      userDataPath,
      { environmentId, distro: 'Ubuntu' },
      () => read.promise
    )

    const starting = startBrowserHost()
    read.reject(new Error('reg.exe failed'))
    await starting

    expect(startedIdentity()).toBe(expectedIdentity(null))
  })

  it('fails closed instead of hanging when the read never settles', async () => {
    vi.useFakeTimers()
    void observeWslHostRegistration(
      userDataPath,
      { environmentId, distro: 'Ubuntu' },
      () => new Promise<string | null>(() => {})
    )

    const starting = startBrowserHost()
    await vi.advanceTimersByTimeAsync(WSL_HOST_REGISTRATION_WAIT_MS)
    await starting

    expect(startedIdentity()).toBe(expectedIdentity(null))
  })

  // Why: a GUID recorded by an earlier read must not stand in for a read that now fails.
  it('fails closed when a later read fails despite the GUID an earlier one recorded', async () => {
    const target = { environmentId, distro: 'Ubuntu' }
    await observeWslHostRegistration(userDataPath, target, async () => WSL_DISTRO_ID_A)
    await observeWslHostRegistration(userDataPath, target, async () => null)
    expect(findWslHostDeployment(userDataPath, environmentId)?.observedDistroId).toBe(
      WSL_DISTRO_ID_A
    )

    await startBrowserHost()

    expect(startedIdentity()).toBe(expectedIdentity(null))
  })
})
