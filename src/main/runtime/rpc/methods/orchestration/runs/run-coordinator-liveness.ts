import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import {
  runCoordinatorKey,
  type OrchestrationCoordinatorKey
} from '../../../../orchestration/orchestration-caller-identity'
import { readAgentSessionRecordStore } from '../../../../orchestration/structured-session-lineage'
import {
  lookupOrcaAgentSession,
  structuredSessionMailReach
} from '../../../../orchestration/structured-session-mail-address'

/**
 * The Run's current coordinator when there is positive evidence it is still running; else null.
 * Only proof counts: a closed chat, an exited or unhooked terminal, another host, or anything that
 * cannot be checked reads as not live, so a restart handoff never needs a flag.
 */
export async function provenLiveRunCoordinator(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  runId: string
): Promise<OrchestrationCoordinatorKey | null> {
  const run = db.getRunRaw(runId)
  if (!run || run.legacy === 1) {
    return null
  }
  const key = runCoordinatorKey(run)
  if (key.orcaSessionId !== null) {
    // Why: the record store opens lazily, as for a send naming a session.
    await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
    const store = readAgentSessionRecordStore()
    const found = store ? lookupOrcaAgentSession(store, key.orcaSessionId) : null
    return store &&
      found?.kind === 'found' &&
      structuredSessionMailReach(store, found.record, db).kind === 'reachable'
      ? key
      : null
  }
  if (key.paneKey !== null) {
    return (await runtime.checkCoordinatorAgentPresence(key.paneKey)) === 'live' ? key : null
  }
  return null
}
