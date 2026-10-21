// A pane's own agent launch, from either start lane: the window pane's pty:spawn, or main's create
// of a window tab's first terminal. Tracked while it runs, refused once the user closed the pane,
// planned by the host's planner, and ended with one verdict to the window. No launch record.

import { AgentLaunch } from '../../shared/rpc-contract/agent-launch-params'
import { toAgentLaunchPreferences } from '../../shared/agent-launch-preferences'
import { hasClosedTerminalTabRecord } from '../../shared/closed-terminal-tab-tombstones'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { AgentLaunchTabClosedError } from '../../shared/agent-launch-tab-closed'
import {
  AGENT_LAUNCH_PANE_REFUSED_CODE,
  type AgentLaunchPaneAddress,
  type AgentLaunchPaneVerdict
} from '../../shared/agent-launch-pane-verdict'
import type { AgentLaunchRuntime } from '../../shared/agent-launch-runtime'
import {
  trackRunningAgentLaunchPane,
  type RunningAgentLaunchPane
} from './agent-launch-pane-attachment'
import { resolveUnlaunchedIntent } from '../runtime/rpc/methods/agent-launch-intent-resolution'
import { agentLaunchFailureCode } from '../runtime/rpc/methods/agent-launch-failure-code'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { TerminalCreateOptions } from '../runtime/runtime-terminal-contracts'
import type { Store } from '../persistence'

export type PaneAgentLaunch = {
  runtime: OrcaRuntimeService
  address: AgentLaunchPaneAddress
  paneKey: string
  running: RunningAgentLaunchPane
  /** The plan's runtime fact: the PTY's shell comes only from it, as for a host launch. */
  launchRuntime?: AgentLaunchRuntime
  /** The provider was asked for the process: a failure after this proves nothing ran. */
  dispatched: boolean
  /** Right before the provider spawn: refuses a launch whose pane the user closed meanwhile. */
  refuseIfClosed: () => void
}

type SessionReader = { getWorkspaceSession?: Store['getWorkspaceSession'] }

export type PaneAgentLaunchEnd =
  | { started: true }
  /** The agent's process started, then exited before it registered. */
  | { exitedDuringStart: true }
  | { error: unknown }

/** Whether the user's close of this pane, or its whole tab, is already committed to main. */
function closedInSession(store: SessionReader | undefined, paneKey: string): boolean {
  const pane = parsePaneKey(paneKey)
  const session = store?.getWorkspaceSession?.()
  return Boolean(
    pane &&
    session &&
    (session.terminalSurfaceTombstonesByPaneKey?.[paneKey] ||
      hasClosedTerminalTabRecord(session.closedTerminalTabTombstonesByTabId, pane.tabId))
  )
}

/** The pane's `agent.launch` request, checked once; a reused terminal or a prompt is not a pane's. */
function parsePaneAgentLaunch(request: unknown, paneKey: string | null) {
  const launch =
    typeof request === 'object' &&
    request !== null &&
    'launch' in request &&
    typeof request.launch === 'object'
      ? request.launch
      : undefined
  const params = AgentLaunch.safeParse({ ...launch, paneKey })
  return params.success && !params.data.reuseTerminal && !params.data.prompt ? params.data : null
}

/**
 * Starts tracking the pane's launch, so a pane that mounts at once waits for it, and resolves what
 * the host's planner builds from it. Throws `agent_launch_request_invalid` before tracking anything.
 */
export async function beginPaneAgentLaunch(args: {
  runtime: OrcaRuntimeService | undefined
  store: SessionReader | undefined
  worktreeId: string | undefined
  paneKey: string | null
  request: unknown
  /** Set once tracking began, before the plan: a plan failure still reports its verdict. */
  onTracked: (launch: PaneAgentLaunch) => void
}): Promise<{ worktree: string; options: TerminalCreateOptions }> {
  const { runtime, worktreeId, paneKey } = args
  const pane = paneKey ? parsePaneKey(paneKey) : null
  const params = parsePaneAgentLaunch(args.request, paneKey)
  if (!runtime || !paneKey || !pane || !worktreeId || !params) {
    throw new Error('agent_launch_request_invalid')
  }
  const running = trackRunningAgentLaunchPane({ worktreeId, paneKey })
  args.onTracked({
    runtime,
    address: { worktreeId, tabId: pane.tabId, leafId: pane.leafId },
    paneKey,
    running,
    dispatched: false,
    refuseIfClosed: () => {
      if (running.closedByUser() || closedInSession(args.store, paneKey)) {
        throw new AgentLaunchTabClosedError()
      }
    }
  })
  const intent = await resolveUnlaunchedIntent(params, runtime, null)
  if (intent.target.kind !== 'existing') {
    throw new Error('agent_launch_request_invalid')
  }
  const launchPreferences = toAgentLaunchPreferences(intent.sessionOptions)
  return {
    worktree: intent.target.worktree,
    options: {
      startupAgent: intent.agent,
      ...(intent.agentArgs !== undefined ? { agentArgs: intent.agentArgs } : {}),
      ...(launchPreferences ? { launchPreferences } : {}),
      ...(intent.launchSource ? { launchSource: intent.launchSource } : {}),
      ...(intent.cwd ? { cwd: intent.cwd } : {})
    }
  }
}

function finish(launch: PaneAgentLaunch, verdict: AgentLaunchPaneVerdict): void {
  launch.running.finish(verdict)
  launch.runtime.reportAgentLaunchPaneVerdict(launch.address, verdict)
}

/** Ends the pane's launch, once; returns the error its start throws, if it failed. */
export function endPaneAgentLaunch(
  launch: PaneAgentLaunch | null,
  end: PaneAgentLaunchEnd
): Error | null {
  if (!launch) {
    return null
  }
  if ('exitedDuringStart' in end) {
    finish(launch, { kind: 'not-started', code: 'agent_session_exited_during_start' })
    return null
  }
  const closed = launch.running.closedByUser()
  if ('started' in end) {
    if (closed) {
      stopClosed(launch)
    } else {
      finish(launch, { kind: 'proceed' })
    }
    return null
  }
  if (closed || end.error instanceof AgentLaunchTabClosedError) {
    stopClosed(launch)
    return toError(end.error)
  }
  finish(
    launch,
    // The provider may have started it before its answer was lost.
    launch.dispatched
      ? { kind: 'unconfirmed' }
      : { kind: 'not-started', code: agentLaunchFailureCode(end.error) }
  )
  return new Error(AGENT_LAUNCH_PANE_REFUSED_CODE)
}

/** The user closed it while it started: its agent, if one spawned, stops, as a closed tab's does. */
function stopClosed(launch: PaneAgentLaunch): void {
  const handle = launch.runtime.getTerminalHandleForPaneKey(launch.paneKey)
  if (handle) {
    void launch.runtime.closeTerminal(handle).catch(() => {})
  }
  launch.running.finish({ kind: 'withdrawn' })
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
