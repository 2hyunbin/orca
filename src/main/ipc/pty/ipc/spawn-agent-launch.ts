// A pane's own agent launch, planned in its reserved spawn by the shared planner; no launch record.

import { randomUUID } from 'node:crypto'
import { agentLaunchTokenFor } from '../../../agent-launch/agent-launch-token'
import { beginPaneAgentLaunch } from '../../../agent-launch/pane-agent-launch-lifecycle'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { resolveEarlyPaneKey } from './spawn-begin'
import type { PtyIpcSpawnState } from './spawn-state'
import type { PtySpawnIpcArgs } from './spawn-types'

/** The planned launch replaces whatever the pane would have run; the pane's own spawn facts stay. */
function withPlannedLaunch(
  args: PtySpawnIpcArgs,
  planned: Awaited<ReturnType<OrcaRuntimeService['planAgentPaneLaunch']>>
): PtySpawnIpcArgs {
  const {
    agentLaunch: _launch,
    command: _command,
    launchConfig: _config,
    launchAgent: _agent,
    startupCommandDelivery: _delivery,
    telemetry: _telemetry,
    // TEMPORARY parity (follow-up 2): a missing folder fails as the host's launch did, never the root.
    cwdFallback: _fallback,
    ...pane
  } = args
  const launchToken = agentLaunchTokenFor(
    {
      launchConfig: planned.launchConfig,
      ...(typeof args.launchToken === 'string' ? { launchToken: args.launchToken } : {})
    },
    randomUUID
  )
  return {
    ...pane,
    command: planned.command,
    ...(planned.env || launchToken
      ? {
          env: {
            ...args.env,
            ...planned.env,
            ...(launchToken ? { ORCA_AGENT_LAUNCH_TOKEN: launchToken } : {})
          }
        }
      : {}),
    ...(launchToken ? { launchToken } : {}),
    ...(planned.launchConfig ? { launchConfig: planned.launchConfig } : {}),
    ...(planned.launchAgent ? { launchAgent: planned.launchAgent } : {}),
    ...(planned.startupCommandDelivery
      ? { startupCommandDelivery: planned.startupCommandDelivery }
      : {}),
    ...(planned.telemetry ? { telemetry: planned.telemetry } : {})
  }
}

export async function planPaneAgentLaunch(ctx: PtyIpcSpawnState): Promise<void> {
  const { args, deps } = ctx
  // A live owner of the pane is adopted below: its agent already runs there.
  if (args.agentLaunch === undefined || ctx.earlyStablePaneOwner) {
    return
  }
  const runtime = deps.runtime
  if (!runtime) {
    throw new Error('agent_launch_request_invalid')
  }
  const { worktree, options } = await beginPaneAgentLaunch({
    runtime,
    store: deps.store,
    worktreeId: args.worktreeId,
    paneKey: resolveEarlyPaneKey(args),
    request: args.agentLaunch,
    onTracked: (launch) => {
      ctx.paneAgentLaunch = launch
    }
  })
  const planned = await runtime.planAgentPaneLaunch(worktree, options)
  if (ctx.paneAgentLaunch) {
    ctx.paneAgentLaunch.launchRuntime = planned.launchRuntime
  }
  ctx.args = withPlannedLaunch(args, planned)
}
