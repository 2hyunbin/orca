// Locks from older servers omit their hostname, so a clone's live server shows only in its profile-state owner records (#32918).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  orcadPeerSharesMachineIdOnly,
  SEPARATE_CLONES_HINT,
  type OrcadPeerMachine
} from './orcad-lock-holder-locality'
import { OrcadInstanceLockError } from './orcad-data-root-privacy'

type SharedMachineIdOwner = { host: string; path: string }

/** Find a profile-state owner written by another host reporting this machine's machine-id. */
export function findSharedMachineIdProfileOwner(
  dataRoot: string,
  self: OrcadPeerMachine,
  dataRootIsOnLocalDisk: () => boolean,
  platform: NodeJS.Platform
): SharedMachineIdOwner | null {
  if (platform !== 'linux') {
    return null
  }
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
        orcadPeerSharesMachineIdOnly(owner, self, dataRootIsOnLocalDisk, platform)
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
    `Orca on ${owner.host} is using the data root ${dataRoot}, and ${owner.host} reports the ` +
      'same /etc/machine-id as this machine (machines cloned from one image share it). Orca ' +
      'cannot check from here whether it is still running, so it will not start a second writer ' +
      `on the same data. Stop Orca on ${owner.host}. If nothing runs there, delete ` +
      `${owner.path}. ${SEPARATE_CLONES_HINT}`
  )
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function readOwnerMachine(path: string): OrcadPeerMachine | null {
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
        ? { bootId: owner.bootIdentity }
        : {})
    }
  } catch {
    // Profile-state admission judges unreadable owners itself.
    return null
  }
}
