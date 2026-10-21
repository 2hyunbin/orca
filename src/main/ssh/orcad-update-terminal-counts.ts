import {
  ORCAD_UPDATE_ADMISSION_FENCE_MS,
  type OrcadTerminalCensus
} from '../../shared/orcad-terminal-census'
import type { OrcadTerminalCensusRequestOptions } from './orcad-terminal-census-client'

/**
 * The counts an update, rollback or restart makes against one incumbent. Only the last, just
 * before the stop, closes its terminal admission: an update's first precedes a long upload.
 */
export function updateTerminalCounts(
  count: (options: OrcadTerminalCensusRequestOptions) => Promise<OrcadTerminalCensus>
): {
  countFirst: () => Promise<OrcadTerminalCensus>
  recountCensus: () => Promise<OrcadTerminalCensus>
  releaseIncumbentAdmission: () => Promise<void>
} {
  // Why release: finished automation shells would otherwise defer every update on a host with
  // schedules; the update restarts the server anyway.
  const release = { releaseFinishedAutomationTerminals: true }
  return {
    countFirst: () => count(release),
    recountCensus: () =>
      count({ ...release, closeAdmissionForMs: ORCAD_UPDATE_ADMISSION_FENCE_MS }),
    releaseIncumbentAdmission: async () => {
      await count({ closeAdmissionForMs: 0 })
    }
  }
}

/**
 * Runs the stop the fenced count admitted, and reopens admission only when its result proves the
 * server keeps serving. A throw may hide a stop still on its way, so admission stays closed and
 * lapses on its own.
 */
export async function reopeningAdmissionUnless<T>(
  stopMayHaveBeenSent: (result: T) => boolean,
  releaseIncumbentAdmission: () => Promise<void>,
  stop: () => Promise<T>
): Promise<T> {
  const result = await stop()
  if (!stopMayHaveBeenSent(result)) {
    await releaseIncumbentAdmission().catch(() => {})
  }
  return result
}
