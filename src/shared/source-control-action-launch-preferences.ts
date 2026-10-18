import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import type { SourceControlActionRecipe } from './source-control-ai-actions'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

/** Agents whose model an action can pick: the ones whose session catalog lists models. */
export function sourceControlActionAgentPicksModel(
  agent: string | null | undefined
): agent is TuiAgent {
  return (
    isTuiAgent(agent) &&
    Boolean(getAgentSessionOptionCatalog(agent)?.supportsWorkerLaunchPreferences)
  )
}

/**
 * The model and effort an action's launch runs on, for whichever route opens it; the execution
 * host validates them. Only the recipe's own agent gets them: another agent would not know the id.
 */
export function resolveSourceControlActionSessionOptions(
  recipe: Pick<SourceControlActionRecipe, 'agentId' | 'launchPreferences'>,
  agent: TuiAgent
): Readonly<Record<string, string>> | undefined {
  const preferences = recipe.launchPreferences
  if (!preferences || recipe.agentId !== agent) {
    return undefined
  }
  return {
    model: preferences.model,
    ...(preferences.effort ? { effort: preferences.effort } : {})
  }
}

/** A launch-time recipe keeps the saved model only while it keeps the saved agent. */
export function withSavedSourceControlActionLaunchPreferences<
  T extends Pick<SourceControlActionRecipe, 'agentId'>
>(recipe: T, saved: Pick<SourceControlActionRecipe, 'agentId' | 'launchPreferences'>): T {
  return saved.launchPreferences && saved.agentId === recipe.agentId
    ? { ...recipe, launchPreferences: saved.launchPreferences }
    : recipe
}
