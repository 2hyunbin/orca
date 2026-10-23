/** Whether an orcad lock or peer record was written on this machine, where its PID means something. */
import process from 'node:process'
import { profileStateAccessMachineIdentity } from '../persistence/profile-state/profile-state-access-identity'
import { readOrcadProcessIncarnation } from './orcad-process-start-time'

/**
 * Same machine: the same machine identity, or (records without one) the same kernel boot. A record
 * that names neither is local only when no other machine can reach the data root.
 */
export function orcadLockHolderLocality(
  holder: OrcadPeerMachine,
  self: OrcadPeerMachine,
  dataRootIsOnLocalDisk: () => boolean
): 'local' | 'foreign' | 'unknown' {
  if (holder.machineIdentity && self.machineIdentity) {
    return holder.machineIdentity === self.machineIdentity ? 'local' : 'foreign'
  }
  if (holder.bootId && holder.bootId === self.bootId) {
    return 'local'
  }
  return dataRootIsOnLocalDisk() ? 'local' : 'unknown'
}

export type OrcadPeerMachine = { machineIdentity?: string; bootId?: string }

export function currentOrcadPeerMachine(): OrcadPeerMachine {
  const machineIdentity = profileStateAccessMachineIdentity()
  const bootId = readOrcadProcessIncarnation(process.pid)?.bootId
  return { ...(machineIdentity ? { machineIdentity } : {}), ...(bootId ? { bootId } : {}) }
}

/**
 * Whether a peer's recorded PID means anything here: same machine and kernel boot. A different or
 * unprovable one leaves the peer unverifiable, never exited.
 */
export function orcadPeerPidIsJudgeableHere(
  peer: OrcadPeerMachine,
  self: OrcadPeerMachine,
  dataRootIsOnLocalDisk: () => boolean
): boolean {
  if (peer.bootId && self.bootId && peer.bootId !== self.bootId) {
    return false
  }
  return orcadLockHolderLocality(peer, self, dataRootIsOnLocalDisk) === 'local'
}
