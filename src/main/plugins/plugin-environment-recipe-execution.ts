import { createHash } from 'node:crypto'
import {
  environmentCommandInput,
  executeReviewedEnvironmentCommand,
  type EnvironmentCommandInvocation
} from './plugin-environment-command-execution'
import {
  environmentRecipeRequestSchema,
  parseEnvironmentRecipeResponse,
  type EnvironmentRecipeRequest
} from '../../shared/environment-recipe-protocol'
import {
  environmentRecipeProviderId,
  pluginEnvironmentRecipeSchema,
  validateEnvironmentRecipeProtocol,
  validateEnvironmentRecipeCreateParameters,
  type PluginEnvironmentRecipe
} from '../../shared/plugins/plugin-environment-recipe-artifact'

export type EnvironmentRecipeInvocation = EnvironmentCommandInvocation<EnvironmentRecipeRequest> & {
  action: EnvironmentRecipeRequest['action']
}
export type { EnvironmentRecipeExecutionResult } from '../../shared/plugins/plugin-environment-recipe-result'
import type { EnvironmentRecipeExecutionResult } from '../../shared/plugins/plugin-environment-recipe-result'

export function environmentRecipeDigest(recipe: PluginEnvironmentRecipe): string {
  return createHash('sha256')
    .update(JSON.stringify(pluginEnvironmentRecipeSchema.parse(recipe)))
    .digest('hex')
}

export async function executePluginEnvironmentRecipe(input: {
  pluginKey: string
  recipe: PluginEnvironmentRecipe
  request: EnvironmentRecipeRequest
  cwd: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  authorize: (
    invocation: EnvironmentRecipeInvocation
  ) => Promise<{ isCurrent: () => boolean; signal: AbortSignal } | null>
}): Promise<EnvironmentRecipeExecutionResult> {
  const recipe = pluginEnvironmentRecipeSchema.parse(structuredClone(input.recipe))
  const request = environmentRecipeRequestSchema.parse(structuredClone(input.request))
  validateEnvironmentRecipeProtocol(recipe, request)
  const cwd = input.cwd
  const env = { ...input.env }
  const providerId = environmentRecipeProviderId(input.pluginKey, recipe)
  if (providerId !== request.providerId) {
    throw new Error('Environment recipe request names another provider')
  }
  const command = recipe.commands[request.action]
  if (!command) {
    return { kind: 'refused', reason: 'unsupported-action' }
  }
  if (request.action === 'create') {
    validateEnvironmentRecipeCreateParameters(recipe, request.parameters)
  }
  const { stdin, requestDigest } = environmentCommandInput(request)
  if (request.action === 'create') {
    Object.freeze(request.parameters)
  }
  const invocation = Object.freeze({
    pluginKey: input.pluginKey,
    providerId,
    operationId: request.operationId,
    action: request.action,
    recipeDigest: environmentRecipeDigest(recipe),
    requestDigest,
    request: Object.freeze(request),
    command: Object.freeze({ ...command, args: Object.freeze([...command.args]) })
  })
  return executeReviewedEnvironmentCommand({
    invocation,
    stdin,
    cwd,
    env,
    signal: input.signal,
    authorize: () => input.authorize(invocation),
    parseResponse: parseEnvironmentRecipeResponse,
    rejectResponse: (response) =>
      request.action !== 'list' && response.kind === 'error' && response.code === 'unavailable'
        ? 'provider-unavailable'
        : null
  })
}
