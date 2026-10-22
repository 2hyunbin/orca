import { z } from 'zod'
import { isTuiAgent } from '../tui-agent-config'
import { agentKindSchema, launchSourceSchema, requestKindSchema } from '../telemetry-events'
import { AgentArgs, LaunchPreferences, PromptDelivery } from './agent-session-params'

const TuiAgentParam = z.string().refine(isTuiAgent)

/** Read only with `windowTab`, from this machine's own window; a bad value drops, never refuses. */
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
