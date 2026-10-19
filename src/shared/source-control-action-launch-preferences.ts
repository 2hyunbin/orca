import {
  findCatalogModel,
  getAgentSessionOptionCatalog,
  type CatalogOption
} from './agent-session-option-catalog'
import type { SourceControlActionRecipe } from './source-control-ai-actions'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'
import { isAgentSessionHandleProvider } from './agent-session-provider-handle'
import { STRUCTURED_LAUNCH_SEED_OPTION_IDS } from './native-chat-session-option-defaults'

/** Agents whose model an action can pick: the ones whose session catalog lists models. */
export function sourceControlActionAgentPicksModel(
  agent: string | null | undefined
): agent is TuiAgent {
  return isTuiAgent(agent) && Boolean(getAgentSessionOptionCatalog(agent)?.models.length)
}

/** Structured controls only; terminal-composed options have no chat implementation. */
export function sourceControlActionChatOptions(agent: TuiAgent, modelId: string): CatalogOption[] {
  const catalog = getAgentSessionOptionCatalog(agent)
  const options =
    findCatalogModel(catalog ?? { models: [], modelApply: {} }, modelId)?.options ??
    catalog?.unknownModelOptions ??
    []
  return options.filter(
    (option) =>
      !option.apply.composedIntoModel &&
      (isAgentSessionHandleProvider(agent)
        ? STRUCTURED_LAUNCH_SEED_OPTION_IDS.some((id) => id === option.id)
        : option.id === 'effort')
  )
}

/** The resolved agent alone can receive its bound action choice. */
export function resolveSourceControlActionSessionOptions(
  recipe: Pick<SourceControlActionRecipe, 'agentId' | 'launchPreferences'>,
  agent: TuiAgent
): Readonly<Record<string, string>> | undefined {
  const preferences = recipe.launchPreferences
  if (
    !preferences ||
    preferences.agentId !== agent ||
    (recipe.agentId != null && recipe.agentId !== agent)
  ) {
    return undefined
  }
  return {
    ...preferences.options,
    model: preferences.model
  }
}

/** A launch-time recipe keeps the saved model only while it keeps the saved agent. */
export function withSavedSourceControlActionLaunchPreferences<
  T extends Pick<SourceControlActionRecipe, 'agentId'>
>(
  recipe: T,
  saved: Pick<SourceControlActionRecipe, 'agentId' | 'launchPreferences'>
): T & Pick<SourceControlActionRecipe, 'launchPreferences'> {
  return saved.launchPreferences && saved.launchPreferences.agentId === recipe.agentId
    ? { ...recipe, launchPreferences: saved.launchPreferences }
    : recipe
}
