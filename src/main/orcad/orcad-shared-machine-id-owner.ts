// Locks from older servers omit their hostname, so a clone's live server shows only in its profile-state owner records (#32918).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  orcadPeerSharesMachineIdOnly,
  SEPARATE_CLONES_HINT,
  type OrcadPeerMachine
} from './orcad-lock-holder-locality'
import { OrcadInstanceLockError } from './orcad-data-root-privacy'
import { profileStateAccessBootIdentity } from '../persistence/profile-state/profile-state-access-identity'
import { profileStateAccessPidNamespace } from '../persistence/profile-state/profile-state-access-owner'

type SharedMachineIdOwner = { host: string; path: string }

/** Find a profile-state owner written by another host reporting this machine's machine-id. */
export function findSharedMachineIdProfileOwner(
  dataRoot: string,
  self: OrcadPeerMachine,
  platform: NodeJS.Platform
): SharedMachineIdOwner | null {
  const access = join(dataRoot, '.profile-state-access')
  const ownerDirs = [join(access, 'maintenance')]
  for (const token of listDir(join(access, 'participants'))) {
    ownerDirs.push(join(access, 'participants', token))
  }
  for (const dir of ownerDirs) {
    for (const name of listDir(dir).filter((entry) => entry.endsWith('.owner'))) {
      const path = join(dir, name)
      const owner = readOwnerMachine(path)
      if (
        owner?.host &&
        orcadPeerSharesMachineIdOnly(owner, self, platform) &&
        !isThisMachineRenamed(owner)
      ) {
        return { host: owner.host, path }
      }
    }
  }
  return null
}

export function sharedMachineIdOwnerError(
  dataRoot: string,
  owner: SharedMachineIdOwner
): OrcadInstanceLockError {
  return new OrcadInstanceLockError(
    'orcad_instance_lock_holder_unverifiable',
    `An Orca server on ${owner.host} is using the data root ${dataRoot}, and ${owner.host} ` +
      'reports the same /etc/machine-id as this machine (machines cloned from one image share ' +
      'it). Orca cannot check from here whether it is still running, so it will not start a ' +
      `second server on the same data. Stop it on ${owner.host}. If nothing runs there, delete ` +
      `${owner.path}. ${SEPARATE_CLONES_HINT}`
  )
}

/** One boot and PID namespace prove a renamed host, as profile-state owner cleanup already judges. */
function isThisMachineRenamed(owner: OwnerRecord): boolean {
  return (
    !!owner.bootIdentity &&
    owner.bootIdentity === profileStateAccessBootIdentity() &&
    !!owner.pidNamespace &&
    owner.pidNamespace === profileStateAccessPidNamespace()
  )
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

type OwnerRecord = OrcadPeerMachine & { bootIdentity?: string; pidNamespace?: string }

function readOwnerMachine(path: string): OwnerRecord | null {
  try {
    const owner: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof owner !== 'object' || owner === null) {
      return null
    }
    return {
      ...('host' in owner && typeof owner.host === 'string' ? { host: owner.host } : {}),
      ...('machineIdentity' in owner && typeof owner.machineIdentity === 'string'
        ? { machineIdentity: owner.machineIdentity }
        : {}),
      ...('bootIdentity' in owner && typeof owner.bootIdentity === 'string'
        ? { bootIdentity: owner.bootIdentity }
        : {}),
      ...('pidNamespace' in owner && typeof owner.pidNamespace === 'string'
        ? { pidNamespace: owner.pidNamespace }
        : {})
    }
  } catch {
    // Profile-state admission judges unreadable owners itself.
    return null
  }
}
