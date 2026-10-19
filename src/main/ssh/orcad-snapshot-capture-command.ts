import { ORCAD_STATE_SNAPSHOT_FLAG } from '../managed-server/host-state/orcad-state-snapshot-members'

/** A fake host's test for a shell or slot-Node capture: a random fence token can contain `-cf`. */
export function isSnapshotCaptureCommand(command: string): boolean {
  return (
    /\btar -C \S+ -cf /u.test(command) || command.includes(`${ORCAD_STATE_SNAPSHOT_FLAG} capture `)
  )
}
