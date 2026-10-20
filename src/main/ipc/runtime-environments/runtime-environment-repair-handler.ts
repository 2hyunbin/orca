import { ipcMain } from 'electron'
import type { VerifyAndAddRuntimeEnvironmentResult } from '../../../shared/remote-pairing-verification'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import { verifyAndRepairRuntimeEnvironmentFromPairingCode } from './runtime-environment-pairing-verification'
import { getRuntimeEnvironmentStatusOwner } from './runtime-environment-request-connections'
import { clearRuntimeEnvironmentManualDisconnect } from './runtime-environment-manual-disconnect'

type VerifiedPairing = Extract<VerifyAndAddRuntimeEnvironmentResult, { ok: true }>

/**
 * Publishes the status a pairing was verified with, retiring the replaced pairing's owner first when
 * `replaced`. One choke point so every save-after-verify path fences against an overlapping save.
 */
export async function publishVerifiedPairing(
  userDataPath: string,
  result: VerifiedPairing,
  replaced: { invalidateTransport: (environmentId: string) => Promise<void> | void } | null
): Promise<void> {
  const environmentId = result.environment.id
  // Why before invalidating: a manually disconnected server would not get a fresh owner.
  clearRuntimeEnvironmentManualDisconnect(environmentId)
  // Retires the owner blocked under the replaced pairing; its replacement keys on the new revision.
  await replaced?.invalidateTransport(environmentId)
  // Why: an overlapping save may have replaced this pairing during the await.
  const saved = listEnvironments(userDataPath).find((entry) => entry.id === environmentId)
  if (saved?.pairingRevision !== result.environment.pairingRevision) {
    return
  }
  getRuntimeEnvironmentStatusOwner(userDataPath, environmentId).acceptVerified({
    id: 'status.get',
    ok: true,
    result: result.runtimeStatus,
    _meta: { runtimeId: result.runtimeStatus.runtimeId }
  })
}

export function registerRuntimeEnvironmentRepairHandler({
  getUserDataPath,
  invalidateTransport
}: {
  getUserDataPath: () => string
  invalidateTransport: (environmentId: string) => Promise<void> | void
}): void {
  ipcMain.handle(
    'runtimeEnvironments:repairFromPairingCode',
    async (
      _event,
      args: { selector: string; pairingCode: string }
    ): Promise<VerifyAndAddRuntimeEnvironmentResult> => {
      const result = await verifyAndRepairRuntimeEnvironmentFromPairingCode(getUserDataPath(), args)
      if (result.ok) {
        await publishVerifiedPairing(getUserDataPath(), result, { invalidateTransport })
      }
      return result
    }
  )
}
