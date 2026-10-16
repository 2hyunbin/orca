import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { closeStructuredAgentSession } from '@/runtime/structured-agent-session-close'
import {
  deleteStructuredAgentLaunchRecord,
  hasStructuredAgentLaunchCancellationTombstonePersisted
} from './structured-agent-session-launch-persistence'
import { markStructuredAgentLaunchCancellation } from './launch-cancel-tombstones-compat/structured-agent-session-launch-cancellation'

/**
 * ORCA_LAYOUT_OWNER=main only: this machine's host refuses a create whose close came first, or
 * closes the chat as it lands, so a local cancel tells the host instead of keeping a tombstone.
 * A host that cannot be told gets the tombstone, as in window-owned builds.
 */
export function cancelStructuredAgentLaunchOnLocalHost(
  sessionId: string,
  launchPromise?: Promise<unknown>
): void {
  deleteStructuredAgentLaunchRecord(sessionId)
  void closeStructuredAgentSession({ kind: 'local' }, sessionId).catch(() =>
    markStructuredAgentLaunchCancellation(
      sessionId,
      LOCAL_EXECUTION_HOST_ID,
      hasStructuredAgentLaunchCancellationTombstonePersisted(sessionId),
      launchPromise
    )
  )
}
