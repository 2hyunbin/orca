import {
  environmentRecipeProviderId,
  pluginEnvironmentRecipeSchema,
  type PluginEnvironmentRecipe
} from '../../shared/plugins/plugin-environment-recipe-artifact'
import {
  environmentRecipeRecoveryRequestSchema,
  parseEnvironmentRecipeRecoveryResponse,
  type EnvironmentRecipeRecoveryRequest,
  type EnvironmentRecipeRecoveryResponse
} from '../../shared/environment-recipe-recovery-protocol'
import type { EnvironmentCommandExecutionResult } from '../../shared/plugins/plugin-environment-recipe-result'
import { environmentRecipeDigest } from './plugin-environment-recipe-execution'
import {
  environmentCommandInput,
  executeReviewedEnvironmentCommand,
  type EnvironmentCommandInvocation,
  type EnvironmentCommandAuthority
} from './plugin-environment-command-execution'

export async function executePluginEnvironmentRecovery(input: {
  pluginKey: string
  recipe: PluginEnvironmentRecipe
  request: EnvironmentRecipeRecoveryRequest
  cwd: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  authorize(
    invocation: EnvironmentCommandInvocation<EnvironmentRecipeRecoveryRequest>
  ): Promise<EnvironmentCommandAuthority | null>
}): Promise<EnvironmentCommandExecutionResult<EnvironmentRecipeRecoveryResponse>> {
  const recipe = pluginEnvironmentRecipeSchema.parse(structuredClone(input.recipe))
  const request = environmentRecipeRecoveryRequestSchema.parse(structuredClone(input.request))
  if (environmentRecipeProviderId(input.pluginKey, recipe) !== request.providerId) {
    throw new Error('Recovery names another provider')
  }
  const recovery = recipe.recovery
  if (recipe.protocolVersion !== 2 || !recovery) {
    return { kind: 'refused', reason: 'unsupported-action' }
  }
  const { stdin, requestDigest } = environmentCommandInput(request)
  Object.freeze(request.operation)
  const invocation = Object.freeze({
    pluginKey: input.pluginKey,
    providerId: request.providerId,
    operationId: request.queryId,
    action: 'inspect-operation',
    recipeDigest: environmentRecipeDigest(recipe),
    requestDigest,
    request: Object.freeze(request),
    command: Object.freeze({ ...recovery.command, args: Object.freeze([...recovery.command.args]) })
  })
  return executeReviewedEnvironmentCommand({
    invocation,
    stdin,
    cwd: input.cwd,
    env: input.env,
    signal: input.signal,
    authorize: input.authorize,
    parseResponse: parseEnvironmentRecipeRecoveryResponse
  })
}
