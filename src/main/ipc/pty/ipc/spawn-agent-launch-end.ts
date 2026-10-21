// Finishes a pane's own agent launch on every way its spawn ends.

import {
  endPaneAgentLaunch as endLaunch,
  type PaneAgentLaunchEnd
} from '../../../agent-launch/pane-agent-launch-lifecycle'
import type { PtyIpcSpawnState } from './spawn-state'

export type { PaneAgentLaunch } from '../../../agent-launch/pane-agent-launch-lifecycle'

/** Ends the pane's launch, once; returns the error its spawn throws, if it failed. */
export function endPaneAgentLaunch(ctx: PtyIpcSpawnState, end: PaneAgentLaunchEnd): Error | null {
  const launch = ctx.paneAgentLaunch
  ctx.paneAgentLaunch = null
  return endLaunch(launch, end)
}
