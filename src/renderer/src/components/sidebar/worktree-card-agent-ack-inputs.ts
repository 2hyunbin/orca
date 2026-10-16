import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { AppState } from '@/store/types'

type AcknowledgedAgentTimesState = Pick<AppState, 'acknowledgedAgentsByPaneKey'>

type AcknowledgedAgentRows = readonly Pick<DashboardAgentRow, 'paneKey'>[]

// Both keys are weak so departed rows and old acknowledgement snapshots can be collected.
const projections = new WeakMap<
  AcknowledgedAgentTimesState['acknowledgedAgentsByPaneKey'],
  WeakMap<AcknowledgedAgentRows, readonly number[]>
>()

/** Projects only the acknowledgement timestamps rendered by one card. */
export function selectAcknowledgedAgentTimes(
  state: AcknowledgedAgentTimesState,
  agents: AcknowledgedAgentRows
): readonly number[] {
  const source = state.acknowledgedAgentsByPaneKey
  let byRows = projections.get(source)
  if (!byRows) {
    byRows = new WeakMap()
    projections.set(source, byRows)
  }
  const cached = byRows.get(agents)
  if (cached) {
    return cached
  }
  const times = Object.freeze(agents.map((agent) => source[agent.paneKey] ?? 0))
  byRows.set(agents, times)
  return times
}
