import { z } from 'zod'
import { isTuiAgent } from '../tui-agent-config'
import { agentKindSchema, launchSourceSchema, requestKindSchema } from '../telemetry-events'
import { AgentArgs, LaunchPreferences, PromptDelivery } from './agent-session-params'

const TuiAgentParam = z.string().refine(isTuiAgent)

/**
 * Layout-owner build: the start inputs a window's own new tab hands main, read only with
 * `windowTab` (main ignores them on any other create). Only the window sends them, to its own
 * main process, so no older host ever reads them.
 */
export const WindowTabStartInputParams = {
  /** `agent_started` for this start; main records it once the spawn commits. */
  telemetry: z
    .object({
      agent_kind: agentKindSchema,
      launch_source: launchSourceSchema,
      request_kind: requestKindSchema
    })
    .optional(),
  /** The pane's own `agent.launch` request, checked as its pty:spawn checks it. */
  agentLaunch: z.object({ launch: z.record(z.string(), z.unknown()) }).optional(),
  /** An agent main's planner builds the launch for (the OpenCode model start). */
  startupAgent: TuiAgentParam.optional(),
  agentArgs: AgentArgs.optional(),
  launchPreferences: LaunchPreferences.optional(),
  startupPrompt: z.string().max(1_000_000).optional(),
  startupPromptDelivery: PromptDelivery.optional(),
  /** A draft the agent takes only once ready; main pastes it then. */
  draftPaste: z
    .object({ agent: TuiAgentParam, content: z.string().min(1).max(1_000_000) })
    .optional()
}
