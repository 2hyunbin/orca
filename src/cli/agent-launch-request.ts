/**
 * How the CLI starts an agent: through `agent.launch`, the host's one launch point that the desktop
 * and phone use too. The user's Chat UI setting picks a chat or a terminal, and the receipt says
 * which ran and why; the CLI never picks the surface itself.
 */

import type { AgentLaunchPrompt, AgentLaunchResult } from '../shared/agent-launch-intent'
import { checkAgentLaunchModelPreferences } from '../shared/agent-launch-model-preferences'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../shared/agent-launch-runtime-capability'
import type { RuntimeStatus } from '../shared/runtime-types'
import type { TuiAgent } from '../shared/tui-agent'
import { isTuiAgent } from '../shared/tui-agent-config'
import { getOptionalStringFlag, rejectValuelessFlag } from './flags'
import { RuntimeClientError, type RuntimeClient, type RuntimeRpcSuccess } from './runtime-client'

type Flags = Map<string, string | boolean>

/** `create` is the `worktree.create` request the CLI already builds; the host strips agent fields. */
export type CliAgentLaunchTarget =
  | { kind: 'existing'; worktree: string }
  | { kind: 'create-worktree'; create: Record<string, unknown> }

export type CliAgentLaunch = {
  agent: TuiAgent
  prompt?: AgentLaunchPrompt
  sessionOptions?: Record<string, string>
}

export function parseCliAgent(value: string): TuiAgent {
  if (!isTuiAgent(value)) {
    throw new RuntimeClientError('invalid_argument', `Unknown TUI agent "${value}"`)
  }
  return value
}

/** The agent, prompt, model and effort a CLI start asks for; refuses a model or effort the launch
 *  could not apply, by the same rule as `orchestration worker-start`. */
export function readCliAgentLaunch(
  flags: Flags,
  agent: TuiAgent,
  target: { createsWorktree: boolean }
): CliAgentLaunch {
  const checked = checkAgentLaunchModelPreferences({
    agent,
    model: getOptionalStringFlag(flags, 'model'),
    effort: getOptionalStringFlag(flags, 'effort'),
    createsWorktree: target.createsWorktree,
    // The execution host verifies an OpenCode model itself before it starts one.
    openCodeModelLaunchSupported: true
  })
  if ('refusal' in checked) {
    throw new RuntimeClientError(checked.refusal.code, checked.refusal.message)
  }
  const prompt = flags.get('prompt')
  rejectValuelessFlag(prompt, 'prompt')
  return {
    agent,
    // A blank prompt is no prompt: the agent starts with nothing sent.
    ...(typeof prompt === 'string' && prompt.trim()
      ? { prompt: { text: prompt, delivery: 'submit' as const } }
      : {}),
    ...(checked.preferences ? { sessionOptions: { ...checked.preferences } } : {})
  }
}

export function hasLaunchModelFlags(flags: Flags): boolean {
  return flags.has('model') || flags.has('effort')
}

export async function hostRunsAgentLaunch(client: RuntimeClient): Promise<boolean> {
  const status = await client.call<RuntimeStatus>('status.get')
  return status.result.capabilities?.includes(AGENT_LAUNCH_RUNTIME_CAPABILITY) === true
}

export function callAgentLaunch(
  client: RuntimeClient,
  launch: CliAgentLaunch,
  request: { target: CliAgentLaunchTarget; presentation?: 'focused' | 'background' }
): Promise<RuntimeRpcSuccess<AgentLaunchResult>> {
  return client.call<AgentLaunchResult>('agent.launch', {
    ...request,
    ...launch,
    launchSource: 'cli'
  })
}

export function formatAgentLaunch(result: AgentLaunchResult): string {
  const { outcome, receipt } = result
  return [
    `agent: ${outcome.kind === 'structured' ? 'chat session' : 'terminal'}`,
    `handle: ${outcome.handle}`,
    ...(outcome.kind === 'structured' ? [`sessionId: ${outcome.sessionId}`] : []),
    `worktreeId: ${result.worktreeId}`,
    `why: ${receipt.detail}`,
    ...(result.prompt ? [`prompt: ${result.prompt.outcome}`] : []),
    ...(result.warning ? [`warning: ${result.warning}`] : [])
  ].join('\n')
}
