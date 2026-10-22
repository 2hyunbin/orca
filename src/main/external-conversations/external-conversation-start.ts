import type { AgentLaunchResult } from '../../shared/agent-launch-intent'
import type { ConnectorAgent } from '../../shared/external-conversation-link'
import type { AgentLaunchParams } from '../../shared/rpc-contract/agent-launch-params'
import { executeAgentLaunch } from '../agent-launch/agent-launch-executor'
import type { AgentLaunchPublishedSurface } from '../agent-launch/agent-launch-execution'
import {
  agentPaneWorkspace,
  type AgentPaneWorkspace
} from '../agent-hooks/agent-transition-detector'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { resolveUnlaunchedIntent } from '../runtime/rpc/methods/agent-launch-intent-resolution'
import { agentLaunchSurfaceFactory } from '../runtime/rpc/methods/agent-launch-surfaces'
import { agentLaunchWorkspaceFactory } from '../runtime/rpc/methods/agent-launch-worktree-creation'
import { refused, type Delivery } from './external-conversation-types'

export type ConversationLaunchInput = {
  agent: ConnectorAgent
  target: AgentLaunchParams['target']
  prompt: string
}

export type ConversationLauncher = {
  launch(
    input: ConversationLaunchInput,
    onSurfacePublished: (surface: AgentLaunchPublishedSurface) => void,
    signal: AbortSignal
  ): Promise<AgentLaunchResult>
  /** The launched workspace as hook rows name it, qualified by the host that runs it. */
  paneWorkspace(worktreeId: string): Promise<AgentPaneWorkspace>
}

/**
 * `agent.launch`'s own executor and factories with no paired caller: a background terminal agent
 * that takes the prompt on argv, in a workspace the target names or creates (worktree or folder).
 */
export function runtimeConversationLauncher(runtime: OrcaRuntimeService): ConversationLauncher {
  const context = { runtime }
  return {
    launch: async ({ agent, target, prompt }, onSurfacePublished, signal) => {
      const intent = await resolveUnlaunchedIntent(
        { agent, target, prompt: { text: prompt, delivery: 'submit' } },
        runtime,
        null
      )
      return executeAgentLaunch({
        runtime,
        intent,
        terminalOnly: true,
        surfaces: agentLaunchSurfaceFactory(context, undefined, undefined, false, undefined, {
          early: null,
          presentation: 'background'
        }),
        workspaces: agentLaunchWorkspaceFactory(context, agent),
        onSurfacePublished,
        signal
      })
    },
    paneWorkspace: async (worktreeId) => {
      const scope = await runtime.showTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
      return agentPaneWorkspace(scope.id, scope.connectionId)
    }
  }
}

/**
 * Launches the conversation's agent and links its pane as soon as the surface is published, so a
 * failure after that still leaves a conversation to follow. A failure before it throws.
 */
export async function launchConversation(
  launcher: ConversationLauncher,
  input: ConversationLaunchInput,
  signal: AbortSignal,
  writeLink: (workspace: AgentPaneWorkspace, paneKey: string) => void
): Promise<Delivery> {
  // Settled to its error, so a failed write waits for the launch instead of going unhandled.
  const link: { written: Promise<unknown> | null } = { written: null }
  const onSurfacePublished = (surface: AgentLaunchPublishedSurface): void => {
    const { outcome } = surface
    if (outcome.kind === 'terminal' && outcome.paneKey) {
      const paneKey = outcome.paneKey
      link.written = launcher
        .paneWorkspace(surface.worktreeId)
        .then((workspace) => writeLink(workspace, paneKey))
        .then(
          () => null,
          (error: unknown) => error ?? new Error('connector_link_failed')
        )
    }
  }
  let result: AgentLaunchResult | null = null
  let launchError: unknown = null
  try {
    result = await launcher.launch(input, onSurfacePublished, signal)
  } catch (error) {
    launchError = error
  }
  if (!link.written) {
    // Turned off before the agent existed: the launch stopped before any effect.
    if (signal.aborted) {
      return refused('connectors_disabled')
    }
    throw launchError ?? new Error('connector_launch_without_pane')
  }
  const linkError = await link.written
  if (linkError) {
    throw linkError
  }
  return result?.prompt?.outcome === 'handed-to-terminal'
    ? { outcome: 'accepted' }
    : { outcome: 'unknown', reason: 'launch_outcome_unknown' }
}
