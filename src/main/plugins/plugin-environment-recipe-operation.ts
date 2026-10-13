import { environmentRecipeRequestSchema } from '../../shared/environment-recipe-protocol'
import {
  environmentRecipeProviderId,
  pluginEnvironmentRecipeSchema,
  validateEnvironmentRecipeProtocol,
  validateEnvironmentRecipeCreateParameters
} from '../../shared/plugins/plugin-environment-recipe-artifact'
import {
  environmentRecipeDigest,
  executePluginEnvironmentRecipe
} from './plugin-environment-recipe-execution'
import { PluginEnvironmentRecipeJournalStore } from './plugin-environment-recipe-journal-store'

export type { JournaledEnvironmentRecipeResult } from '../../shared/plugins/plugin-environment-recipe-result'
import type { JournaledEnvironmentRecipeResult } from '../../shared/plugins/plugin-environment-recipe-result'

export async function executeJournaledPluginEnvironmentRecipe(
  input: Parameters<typeof executePluginEnvironmentRecipe>[0] & {
    userDataPath: string
    executionHostId: string
    sourceDigest: string
    journalId?: string
  }
): Promise<JournaledEnvironmentRecipeResult> {
  const recipe = pluginEnvironmentRecipeSchema.parse(structuredClone(input.recipe))
  const request = environmentRecipeRequestSchema.parse(structuredClone(input.request))
  validateEnvironmentRecipeProtocol(recipe, request)
  const execution = { ...input, recipe, request, env: { ...input.env } }
  const providerId = environmentRecipeProviderId(input.pluginKey, recipe)
  if (providerId !== request.providerId) {
    throw new Error('Environment operation names another provider')
  }
  if (request.action === 'create' && recipe.commands.create) {
    validateEnvironmentRecipeCreateParameters(recipe, request.parameters)
  }
  const journal = new PluginEnvironmentRecipeJournalStore(input.userDataPath, {
    executionHostId: input.executionHostId,
    providerId,
    ...(request.contextId !== undefined ? { contextId: request.contextId } : {}),
    sourceDigest: input.sourceDigest,
    ...(input.journalId ? { journalId: input.journalId } : {}),
    recipeDigest: environmentRecipeDigest(recipe)
  })
  const intent = await journal.begin(request)
  if (intent.kind === 'recorded') {
    return { kind: 'recorded', operation: intent.operation }
  }
  // Exceptions or failed durable completion leave the intent pending; never retry implicitly.
  const result = await executePluginEnvironmentRecipe(execution)
  const operation = await journal.finish(request, result)
  return { kind: 'executed', operation, result }
}
