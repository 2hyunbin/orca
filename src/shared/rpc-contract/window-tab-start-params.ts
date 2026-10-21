import { z } from 'zod'
import { isTuiAgent } from '../tui-agent-config'
import { agentKindSchema, launchSourceSchema, requestKindSchema } from '../telemetry-events'
import { AgentArgs, LaunchPreferences, PromptDelivery } from './agent-session-params'

const TuiAgentParam = z.string().refine(isTuiAgent)

/**
 * Layout-owner build: the start inputs a window's own new tab hands main, read only with
 * `windowTab` (main ignores them on any other create). Only the window sends them, to its own
 * main process, so no older host ever reads them. A value that does not parse is dropped, as
 * before these keys existed, so another caller's create is never refused over one.
 */
export const WindowTabStartInputParams = {
  /** `agent_started` for this start; main records it once the spawn commits. */
  telemetry: z
    .object({
      agent_kind: agentKindSchema,
      launch_source: launchSourceSchema,
      request_kind: requestKindSchema
    })
    .optional()
    .catch(undefined),
  // Unchecked here: main's launch lifecycle checks it, so one it cannot read still gets a verdict.
  agentLaunch: z.unknown().optional(),
  /** An agent main's planner builds the launch for (the OpenCode model start). */
  startupAgent: TuiAgentParam.optional().catch(undefined),
  agentArgs: AgentArgs.optional().catch(undefined),
  launchPreferences: LaunchPreferences.optional().catch(undefined),
  startupPrompt: z.string().optional().catch(undefined),
  startupPromptDelivery: PromptDelivery.optional().catch(undefined),
  /** A draft the agent takes only once ready; main pastes it then. */
  draftPaste: z
    .object({ agent: TuiAgentParam, content: z.string().min(1) })
    .optional()
    .catch(undefined)
}
