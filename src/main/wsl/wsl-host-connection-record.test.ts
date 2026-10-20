import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import {
  addWslHostEnvironment,
  findWslHostDeployment
} from '../../shared/runtime-environment-wsl-host-store'
import type { WslHostDeploymentRecord } from '../../shared/wsl-host-deployment-store'
import { observeWslHostRegistration } from './wsl-host-connection-record'

const distroId = '0e3a7f2c-1b4d-4c5e-9f60-7a8b9c0d1e2f'

describe('WSL host registration observation', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-host-registration-'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  /** A host added with `addedDistroId`, or by a build that did not capture the GUID. */
  function addHost(addedDistroId?: string): WslHostDeploymentRecord {
    addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode: encodePairingOffer({
        v: 2,
        endpoint: 'ws://127.0.0.1:42000',
        deviceToken: 'token-1',
        publicKeyB64: Buffer.alloc(32, 7).toString('base64')
      }),
      record: {
        kind: 'wsl',
        distro: 'Ubuntu',
        ...(addedDistroId ? { distroId: addedDistroId } : {}),
        localPort: 42000,
        remotePort: 6768
      }
    })
    const record = findWslHostDeployment(userDataPath, 'wsl:ubuntu')
    if (!record) {
      throw new Error('missing WSL host record')
    }
    return record
  }

  it('records the GUID the registry reports for the distro', async () => {
    const record = addHost()
    const read = vi.fn(async (_distro: string) => distroId)

    expect(await observeWslHostRegistration(userDataPath, record, read)).toBe(true)
    expect(read).toHaveBeenCalledWith('Ubuntu')
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')).toMatchObject({
      observedDistroId: distroId
    })
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.distroId).toBeUndefined()
  })

  // Why: without the GUID the browser identity fails closed, so a failed read must change nothing.
  const failedReads: { label: string; read: (distro: string) => Promise<string | null> }[] = [
    { label: 'unreadable', read: async () => null },
    {
      label: 'failing',
      read: async () => {
        throw new Error('reg.exe failed')
      }
    }
  ]
  it.each(failedReads)('leaves the GUID absent when the registry is $label', async ({ read }) => {
    const record = addHost()

    expect(await observeWslHostRegistration(userDataPath, record, read)).toBe(false)
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.observedDistroId).toBeUndefined()
  })

  it('records nothing when the registry matches the GUID captured at add', async () => {
    const record = addHost(distroId)
    const read = vi.fn(async (_distro: string) => distroId)

    expect(await observeWslHostRegistration(userDataPath, record, read)).toBe(false)
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.observedDistroId).toBeUndefined()
  })

  // Why: a re-import under the same name keeps the record but mints a new registration.
  it('records a re-imported distro under its new GUID, keeping the one captured at add', async () => {
    const reImportedId = '1a2b3c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d'
    const record = addHost(distroId)

    expect(await observeWslHostRegistration(userDataPath, record, async () => reImportedId)).toBe(
      true
    )
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')).toMatchObject({
      distroId,
      observedDistroId: reImportedId
    })
  })
})
