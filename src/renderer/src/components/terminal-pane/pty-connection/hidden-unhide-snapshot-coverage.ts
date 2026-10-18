import type { PtyModelRestoreNeededEvent } from '../../../../../shared/pty-model-restore-marker'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function handleUnhideRestoreBackpressure(
  session: ConnectPanePtySession,
  event: PtyModelRestoreNeededEvent
): void {
  if (
    event.reason !== 'unhide' ||
    session.hiddenOutputRestoreInFlight === null ||
    typeof event.markerSeq !== 'number' ||
    !Number.isFinite(event.markerSeq)
  ) {
    session.noteHiddenOutputRestoreFloodBackpressure()
    return
  }
  // The pending snapshot may already cover this repeat of the hidden gap.
  session.hiddenOutputRestoreUnhideSeq = Math.max(
    session.hiddenOutputRestoreUnhideSeq ?? 0,
    event.markerSeq
  )
}

export function consumeSnapshotRequirement(
  session: ConnectPanePtySession,
  snapshotSeq: number | undefined
): boolean {
  const unhideSeq = session.hiddenOutputRestoreUnhideSeq
  const freshSnapshotNeeded = session.hiddenOutputRestoreFreshSnapshotNeeded
  const uncoveredUnhide =
    typeof unhideSeq === 'number' &&
    (typeof snapshotSeq !== 'number' || !Number.isFinite(snapshotSeq) || snapshotSeq < unhideSeq)
  session.hiddenOutputRestoreReplayingSnapshot = null
  session.hiddenOutputRestoreUnhideSeq = uncoveredUnhide ? unhideSeq : null
  session.hiddenOutputRestoreFreshSnapshotNeeded = false
  return freshSnapshotNeeded || uncoveredUnhide
}

export function repairUnhandledMarker(
  session: ConnectPanePtySession,
  task: Promise<void>,
  ptyId: string
): void {
  if (
    session.hiddenOutputRestoreInFlight === task &&
    !session.disposed &&
    session.transport.getPtyId() === ptyId &&
    typeof session.hiddenOutputRestoreUnhideSeq === 'number' &&
    !session.hiddenOutputRestoreNeeded &&
    !session.hiddenOutputRestoreRetryDeferred
  ) {
    session.hiddenOutputRestoreUnhideSeq = null
    session.noteHiddenOutputRestoreFloodBackpressure()
  }
}
