// Layout-owner build: the start inputs of a window tab's first terminal that need more than main's
// create options. An agent launch runs as its pane's own pty:spawn runs it (tracked, refused once
// closed, one verdict); a draft its agent takes only once ready is pasted by main, its one owner.
import {
  beginPaneAgentLaunch,
  endPaneAgentLaunch,
  type PaneAgentLaunch
} from '../../../agent-launch/pane-agent-launch-lifecycle'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { agentLaunchFailureCode } from '../../rpc/methods/agent-launch-failure-code'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeStore } from '../../runtime-store-contract'
import type { WorktreeStartupDraftPaste } from '../../runtime-worktree-agent-startup'
import type * as dependencies from '../../orca-runtime-create-terminal-dependencies'
import type { z } from 'zod'
import type { WindowTabStartInputParams } from '../../../../shared/rpc-contract/window-tab-start-params'

export type WindowTabStartInputs = {
  /** The pane's own `agent.launch` request, as its pty:spawn carries it. */
  agentLaunch?: unknown
  /** A draft its agent takes only after start: pasted once the agent is ready. */
  draftPaste?: { agent: TuiAgent; content: string }
}

/** The window tab's start inputs from its `terminal.create` params, as main's create reads them. */
export function windowTabStartOptions(
  params: z.infer<z.ZodObject<typeof WindowTabStartInputParams>>
): Partial<CreateOptions> & WindowTabStartInputs {
  return {
    ...(params.telemetry ? { telemetry: params.telemetry } : {}),
    ...(params.agentLaunch !== undefined ? { agentLaunch: params.agentLaunch } : {}),
    ...(params.startupAgent ? { startupAgent: params.startupAgent } : {}),
    ...(params.agentArgs !== undefined ? { agentArgs: params.agentArgs } : {}),
    ...(params.launchPreferences ? { launchPreferences: params.launchPreferences } : {}),
    ...(params.startupPrompt !== undefined ? { startupPrompt: params.startupPrompt } : {}),
    // As createAgentSession plans it: the prompt rides the launch line at any size.
    ...(params.startupPromptDelivery
      ? { startupPromptDelivery: params.startupPromptDelivery, startupPromptCarry: 'force-line' }
      : {}),
    ...(params.draftPaste ? { draftPaste: params.draftPaste } : {})
  }
}

type CreateOptions = Omit<dependencies.TerminalCreateOptions, 'tabId' | 'leafId' | 'presentation'>
type Create = (opts: CreateOptions) => Promise<dependencies.RuntimeTerminalCreate>

export type WindowTabStartHost = {
  runtime: OrcaRuntimeService
  store: RuntimeStore | null | undefined
  pasteDraft: (handle: string, draft: WorktreeStartupDraftPaste) => void
}

export async function startWindowTabWithInputs(
  host: WindowTabStartHost,
  pane: { worktreeId: string; tabId: string; leafId: string },
  { agentLaunch, draftPaste, ...opts }: CreateOptions & WindowTabStartInputs,
  create: Create
): Promise<dependencies.RuntimeTerminalCreate> {
  if (opts.startupAgent && opts.resumeProviderSession) {
    // As the window's own model start refuses it: a model launch cannot resume a session.
    return create({ ...opts, startFailure: new Error('capability_unsupported') })
  }
  const terminal =
    agentLaunch === undefined
      ? await create(opts)
      : await startPaneAgentLaunch(host, pane, agentLaunch, opts, create)
  if (draftPaste && !terminal.isReattach) {
    host.pasteDraft(terminal.handle, draftPaste)
  }
  return terminal
}

async function startPaneAgentLaunch(
  host: WindowTabStartHost,
  pane: Parameters<typeof startWindowTabWithInputs>[1],
  launchRequest: unknown,
  opts: CreateOptions,
  create: Create
): Promise<dependencies.RuntimeTerminalCreate> {
  // The planned launch replaces whatever the pane would have run, as in its own spawn.
  const {
    command: _command,
    launchConfig: _config,
    launchAgent: _agent,
    startupCommandDelivery: _delivery,
    telemetry: _telemetry,
    env,
    ...paneOpts
  } = opts
  const began: { launch: PaneAgentLaunch | null } = { launch: null }
  let planned: CreateOptions
  try {
    const request = await beginPaneAgentLaunch({
      runtime: host.runtime,
      store: host.store ?? undefined,
      worktreeId: pane.worktreeId,
      paneKey: makePaneKey(pane.tabId, pane.leafId),
      request: launchRequest,
      onTracked: (tracked) => {
        began.launch = tracked
      }
    })
    // It starts in the pane's own workspace, never one its request names instead.
    if (request.worktree !== pane.worktreeId) {
      throw new Error('agent_launch_request_invalid')
    }
    // Planned here, as the pane's own spawn plans it, so the pane's env stays under the plan's.
    const { startupAgent: _startupAgent, ...plan } = await host.runtime.planAgentPaneLaunch(
      pane.worktreeId,
      { ...paneOpts, ...request.options, cwd: request.options.cwd ?? paneOpts.cwd }
    )
    planned = { ...plan, ...(env || plan.env ? { env: { ...env, ...plan.env } } : {}) }
  } catch (error) {
    if (began.launch) {
      endPaneAgentLaunch(began.launch, { error })
    } else {
      // Refused before it was tracked: the window still hears, as the pane's own spawn tells it.
      host.runtime.reportAgentLaunchPaneVerdict(
        { worktreeId: pane.worktreeId, tabId: pane.tabId, leafId: pane.leafId },
        { kind: 'not-started', code: agentLaunchFailureCode(error) }
      )
    }
    // The pane stays, showing why.
    return create({ ...paneOpts, startFailure: toError(error) })
  }
  const tracked = began.launch
  try {
    const terminal = await create({
      ...planned,
      onPtySpawnDispatched: () => {
        // Right before the provider spawn: a pane the user closed meanwhile starts nothing.
        tracked?.refuseIfClosed()
        if (tracked) {
          tracked.dispatched = true
        }
      }
    })
    endPaneAgentLaunch(tracked, { started: true })
    return terminal
  } catch (error) {
    endPaneAgentLaunch(
      tracked,
      toError(error).message === 'agent_session_exited_during_start'
        ? { exitedDuringStart: true }
        : { error }
    )
    // The pane already shows main's own failure; the verdict only told the window's launch.
    throw error
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
