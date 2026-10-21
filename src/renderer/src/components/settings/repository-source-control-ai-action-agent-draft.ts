import type {
  SourceControlActionId,
  SourceControlActionLaunchPreferences
} from '../../../../shared/source-control-ai-actions'
import type { RepoSourceControlAiOverrides } from '../../../../shared/source-control-ai-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  normalizeRepoAiDraft,
  readCompleteRecipeForDraft,
  setActionOverride
} from './repository-source-control-ai-draft'

type RepoActionRecipe = NonNullable<
  NonNullable<RepoSourceControlAiOverrides['actionOverrides']>[SourceControlActionId]
>

/** A legacy partial override (no agent of its own) is edited as the complete recipe it resolves
 *  to, so the edit keeps the agent the row shows. */
function currentActionRecipe(
  base: RepoSourceControlAiOverrides,
  settings: GlobalSettings | null,
  actionId: SourceControlActionId
): RepoActionRecipe {
  const stored = base.actionOverrides?.[actionId]
  if (stored?.agentId !== undefined) {
    return stored
  }
  const complete = readCompleteRecipeForDraft(base, settings, actionId)
  // Why: the complete form omits empty args, but explicitly empty args still suppress defaults.
  const emptyArgs = stored?.agentArgs !== undefined && !stored.agentArgs?.trim()
  return emptyArgs ? { ...complete, agentArgs: stored.agentArgs } : complete
}

export function withRepoAiActionAgent(
  base: RepoSourceControlAiOverrides,
  settings: GlobalSettings | null,
  actionId: SourceControlActionId,
  agentId: RepoActionRecipe['agentId']
): RepoSourceControlAiOverrides {
  const currentRecipe = currentActionRecipe(base, settings, actionId)
  // A model and permission mode are one agent's choices; neither survives a change of agent.
  const { launchPreferences, ...rest } = currentRecipe
  return normalizeRepoAiDraft(
    setActionOverride(base, actionId, {
      ...rest,
      ...(launchPreferences && currentRecipe.agentId === agentId ? { launchPreferences } : {}),
      agentId
    })
  )
}

export function withRepoAiActionLaunchPreferences(
  base: RepoSourceControlAiOverrides,
  settings: GlobalSettings | null,
  actionId: SourceControlActionId,
  launchPreferences: SourceControlActionLaunchPreferences | undefined
): RepoSourceControlAiOverrides {
  const { launchPreferences: _previous, ...currentRecipe } = currentActionRecipe(
    base,
    settings,
    actionId
  )
  return normalizeRepoAiDraft(
    setActionOverride(base, actionId, {
      ...currentRecipe,
      ...(launchPreferences ? { launchPreferences } : {})
    })
  )
}
