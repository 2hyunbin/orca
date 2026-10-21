/** What a WSL host's connection change writes to its records, and how the UI sees its status. */
import {
  observeWslHostDistroId,
  refreshWslHostPairing
} from '../../shared/runtime-environment-wsl-host-store'
import type { WslHostDeploymentRecord } from '../../shared/wsl-host-deployment-store'
import type { WslHostStatus } from '../../shared/wsl-host-types'
import { readWslDistroRegistryId } from './wsl-distro-registry-id'
import type { WslOrcadConnection } from './wsl-orcad-connection'
import type { WslOrcadConnectionStatus } from './wsl-orcad-connection-status'

/** Saves an explicit re-pair or a moved bridge; true when the pairing changed. */
export function persistWslHostConnection(
  userDataPath: string,
  record: WslHostDeploymentRecord,
  connection: WslOrcadConnection | null
): boolean {
  if (!connection) {
    // Why: a dropped connection may precede an unregister and re-import, so its read stops vouching.
    latestRegistrationReads.delete(record.environmentId)
    return false
  }
  // Why fire-and-forget: a reg.exe read must not delay saving the pairing; browser starts await it.
  void observeWslHostRegistration(userDataPath, record)
  try {
    return refreshWslHostPairing(userDataPath, record.environmentId, {
      pairingCode: connection.pairingOffer,
      localPort: connection.localPort,
      remotePort: connection.remotePort
    }).pairingChanged
  } catch (error) {
    console.warn(`[wsl-hosts] Could not save the new pairing for ${record.distro}:`, error)
    return false
  }
}

type WslHostRegistrationTarget = Pick<WslHostDeploymentRecord, 'environmentId' | 'distro'>
type WslHostRegistrationRead = { distroId: string | null; recorded: boolean }

/** Bounds a browser start's wait on reg.exe, whose own timeout is 5s. */
export const WSL_HOST_REGISTRATION_WAIT_MS = 6_000

// Why per process: only a read this process ran vouches for the registration running now.
const latestRegistrationReads = new Map<
  string,
  { distro: string; read: Promise<WslHostRegistrationRead>; failed: boolean }
>()

// Why uncached: the 30s shared read can predate an unregister and re-import under the same name.
const readLiveRegistryId = (distro: string): Promise<string | null> =>
  readWslDistroRegistryId(distro)

/** Records the live registration GUID when the record lacks it or names an older one (a re-import). */
export async function observeWslHostRegistration(
  userDataPath: string,
  record: WslHostRegistrationTarget,
  readRegistryId: (distro: string) => Promise<string | null> = readLiveRegistryId
): Promise<boolean> {
  return (await startRegistrationRead(userDataPath, record, readRegistryId)).recorded
}

/**
 * The GUID the registry reported for the host's distro, awaiting the latest read or starting one.
 * Null when it failed or outlasted `timeoutMs`: the browser then fails closed instead of waiting.
 */
export async function awaitWslHostRegistration(
  userDataPath: string,
  target: WslHostRegistrationTarget,
  options: {
    timeoutMs?: number
    readRegistryId?: (distro: string) => Promise<string | null>
  } = {}
): Promise<string | null> {
  const latest = latestRegistrationReads.get(target.environmentId)
  // Why retry a failed read: otherwise one transient reg.exe failure pins the fallback jar.
  const read =
    latest?.distro === target.distro && !latest.failed
      ? latest.read
      : startRegistrationRead(userDataPath, target, options.readRegistryId)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), options.timeoutMs ?? WSL_HOST_REGISTRATION_WAIT_MS)
  })
  try {
    return await Promise.race([read.then((outcome) => outcome.distroId), timedOut])
  } finally {
    clearTimeout(timer)
  }
}

export function resetWslHostRegistrationReadsForTests(): void {
  latestRegistrationReads.clear()
}

function startRegistrationRead(
  userDataPath: string,
  target: WslHostRegistrationTarget,
  readRegistryId: (distro: string) => Promise<string | null> = readLiveRegistryId
): Promise<WslHostRegistrationRead> {
  const entry = {
    distro: target.distro,
    read: readAndRecordRegistration(userDataPath, target, readRegistryId),
    failed: false
  }
  latestRegistrationReads.set(target.environmentId, entry)
  void entry.read.then((outcome) => {
    entry.failed = outcome.distroId === null
  })
  return entry.read
}

async function readAndRecordRegistration(
  userDataPath: string,
  target: WslHostRegistrationTarget,
  readRegistryId: (distro: string) => Promise<string | null>
): Promise<WslHostRegistrationRead> {
  try {
    const distroId = await readRegistryId(target.distro)
    if (distroId === null) {
      return { distroId: null, recorded: false }
    }
    const recorded = observeWslHostDistroId(userDataPath, target.environmentId, {
      distro: target.distro,
      distroId
    })
    return { distroId, recorded }
  } catch (error) {
    console.warn(`[wsl-hosts] Could not record the registration of ${target.distro}:`, error)
    return { distroId: null, recorded: false }
  }
}

export function toWslHostStatus(
  record: WslHostDeploymentRecord,
  status: WslOrcadConnectionStatus,
  connection: WslOrcadConnection | null = null
): WslHostStatus {
  return {
    environmentId: record.environmentId,
    distro: record.distro,
    state: status.state,
    detail: status.state === 'failed' || status.state === 'unverifiable' ? status.reason : null,
    // Only a ready host is serving the incumbent the deferral describes.
    deferredUpdate: status.state === 'ready' ? (connection?.deferredUpdate ?? null) : null
  }
}
