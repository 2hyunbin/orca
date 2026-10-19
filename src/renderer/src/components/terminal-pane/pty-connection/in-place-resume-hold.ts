import { holdPaneResumeInPlace } from '@/lib/pane-spawn-deferral-registry'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'

/** While `attempt` runs, the pane owns the resume record `startup` came from. */
export function holdInPlaceResumeUntilSettled(
  session: ConnectPanePtySession,
  startup: ColdRestoreAgentResumeStartup | null | undefined,
  attempt: Promise<unknown>
): void {
  const recordEntry = startup?.sleepingRecordEntry
  if (!recordEntry) {
    return
  }
  const release = holdPaneResumeInPlace(recordEntry.paneKey, () => !session.disposed)
  void attempt.then(release, release)
}
