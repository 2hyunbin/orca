import { ORCAD_UPDATE_ADMISSION_STOP_BY_MS } from '../../../shared/orcad-terminal-census'
import type { OrcadRollbackOptions, OrcadRollbackResult } from '../install/orcad-remote-rollback'

/** A failed reopen only leaves the fence to lapse on its own. */
export async function reopenAdmission(options: OrcadRollbackOptions): Promise<void> {
  await options.releaseIncumbentAdmission().catch(() => {})
}

/**
 * The last count before the stop, under the host lock like an update's: it closes the server's
 * terminal admission, and refuses (reopening it) unless it proves no terminal runs.
 */
export async function recountUnderLock(
  options: OrcadRollbackOptions,
  now: () => Date
): Promise<{ stopBy: number; refusal: OrcadRollbackResult | null }> {
  const stopBy = now().getTime() + ORCAD_UPDATE_ADMISSION_STOP_BY_MS
  const census = await options.recountCensus().catch(() => null)
  const live = census ? census.liveSessions : null
  if (live === 0) {
    return { stopBy, refusal: null }
  }
  await reopenAdmission(options)
  return {
    stopBy,
    refusal: {
      outcome: 'refused',
      code:
        live === null ? 'orcad_rollback_census_unavailable' : 'orcad_rollback_terminals_running',
      reason:
        live === null
          ? 'The server did not answer how many terminals it runs. Retry when it answers.'
          : 'A terminal opened on this server before it could be stopped; close it, then retry.'
    }
  }
}
