/** State-snapshot ops run by a slot's own Node bundle (`orcad --orcad-state-snapshot`). */
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import type { RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import {
  orcadNodeSlotRuntimeCommand,
  selectOrcadSlotEntryCommand
} from '../install/orcad-remote-runtime'
import { serializedStateMutationCommand, windowsStateCommand } from './orcad-state-snapshot'
import { ORCAD_SNAPSHOT_FAILURE, ORCAD_STATE_SNAPSHOT_FLAG } from './orcad-state-snapshot-members'

/**
 * The activation's capture: the same op, run by the candidate slot's own Node bundle inside the
 * same lock and deadline. Why the candidate: its preflight just proved it runs, and this client
 * built it. It also prunes every other `pre-*` capture beside it but `keep` (#30491).
 */
export function captureOrcadStateSnapshotWithSlotCommand(
  host: RemoteHostPlatform,
  userDataDir: string,
  snapshotDir: string,
  baseDir: string,
  slotDir: string,
  keep: readonly string[]
): string {
  const windows = windowsStateCommand(host, baseDir, 'snapshot-capture', [userDataDir, snapshotDir])
  if (windows) {
    return windows
  }
  const args = [userDataDir, snapshotDir, ...keep].map(quotePosixShell).join(' ')
  const noRuntime = `${ORCAD_SNAPSHOT_FAILURE} The candidate slot names no runnable Node runtime.`
  return serializedStateMutationCommand(
    baseDir,
    [
      // A subshell, so the selection's `exit 78` becomes a reason rather than a silent exit.
      `orcad_runtime=$(${orcadNodeSlotRuntimeCommand(host, slotDir)}printf %s "$orcad_runtime") ||`,
      `{ echo ${quotePosixShell(noRuntime)}; echo FAILED; exit 0; };`,
      `${selectOrcadSlotEntryCommand(host, slotDir)};`,
      `ORCA_BACKGROUND_LAUNCH=1 "$orcad_runtime" "$orcad_entry" ${ORCAD_STATE_SNAPSHOT_FLAG} capture ${args}`
    ].join(' ')
  )
}
