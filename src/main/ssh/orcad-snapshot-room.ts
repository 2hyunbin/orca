/** Whether the pre-activation snapshot fits, asked before the running server is stopped (#30491). */
import { orcadRemoteBaseDir } from '../managed-server/install/orcad-remote-windows-node'
import { execOrcadRemoteOr } from '../managed-server/install/orcad-remote-runtime-control'
import {
  ORCAD_STATE_SNAPSHOT_DIR,
  type OrcadActivationRecord
} from '../managed-server/activation/orcad-activation-record'
import {
  orcadSnapshotShortfallKb,
  orcadSnapshotShortfallMessage,
  orcadSnapshotSpaceCommand,
  parseOrcadSnapshotSpace
} from '../managed-server/host-state/orcad-state-snapshot-space'
import { joinRemotePath } from './ssh-remote-platform'
import type { OrcadSlotOptions } from './orcad-recovery-slot'

export const ORCAD_SNAPSHOT_SPACE_INSUFFICIENT_CODE = 'orcad_snapshot_space_insufficient'

export function orcadSnapshotsRoot(options: Pick<OrcadSlotOptions, 'host' | 'remoteHome'>): string {
  return joinRemotePath(
    options.host,
    orcadRemoteBaseDir(options.host, options.remoteHome),
    ORCAD_STATE_SNAPSHOT_DIR
  )
}

/** The refusal to show when the snapshot cannot fit, or null to go ahead (an unread answer too). */
export async function orcadSnapshotRoomRefusal(
  options: OrcadSlotOptions,
  record: OrcadActivationRecord,
  fullVersion: string
): Promise<string | null> {
  const baseDir = orcadRemoteBaseDir(options.host, options.remoteHome)
  const command = orcadSnapshotSpaceCommand(
    options.host,
    options.userDataDir,
    orcadSnapshotsRoot(options),
    baseDir,
    record.snapshot ? [record.snapshot.dirName] : []
  )
  if (!command) {
    return null
  }
  const space = parseOrcadSnapshotSpace(await execOrcadRemoteOr(options, command))
  const shortfall = orcadSnapshotShortfallKb(space)
  return space && shortfall !== null
    ? orcadSnapshotShortfallMessage(space, shortfall, {
        userDataDir: options.userDataDir,
        baseDir,
        fullVersion,
        active: record.active
      })
    : null
}
