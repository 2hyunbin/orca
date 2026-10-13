import { createHash } from 'node:crypto'
import { runProcess } from '@orca/process-host'
import {
  ENVIRONMENT_RECIPE_INPUT_BYTES,
  ENVIRONMENT_RECIPE_OUTPUT_BYTES,
  environmentRecipeRequestSchema,
  parseEnvironmentRecipeResponse,
  type EnvironmentRecipeRequest,
  type EnvironmentRecipeResponse
} from '../../shared/environment-recipe-protocol'
import {
  environmentRecipeProviderId,
  pluginEnvironmentRecipeSchema,
  validateEnvironmentRecipeCreateParameters,
  type EnvironmentRecipeCommand,
  type PluginEnvironmentRecipe
} from '../../shared/plugins/plugin-environment-recipe-artifact'

export type EnvironmentRecipeInvocation = Readonly<{
  pluginKey: string
  providerId: string
  operationId: string
  action: EnvironmentRecipeRequest['action']
  recipeDigest: string
  requestDigest: string
  command: Readonly<Omit<EnvironmentRecipeCommand, 'args'>> & { readonly args: readonly string[] }
  request: Readonly<EnvironmentRecipeRequest>
}>
export type EnvironmentRecipeExecutionResult =
  | { kind: 'completed'; response: EnvironmentRecipeResponse }
  | { kind: 'refused'; reason: 'approval-required' | 'unsupported-action' | 'cancelled' }
  | {
      kind: 'unverifiable'
      reason:
        | 'cancelled'
        | 'timeout'
        | 'output-limit'
        | 'command-failed'
        | 'invalid-response'
        | 'authority-changed'
    }

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
  const stdin = `${JSON.stringify(request)}\n`
  if (Buffer.byteLength(stdin) > ENVIRONMENT_RECIPE_INPUT_BYTES) {
    throw new Error('Environment recipe request exceeds its byte limit')
  }
  if (request.action === 'create') {
    Object.freeze(request.parameters)
  }
  const invocation = Object.freeze({
    pluginKey: input.pluginKey,
    providerId,
    operationId: request.operationId,
    action: request.action,
    recipeDigest: environmentRecipeDigest(recipe),
    requestDigest: createHash('sha256').update(stdin).digest('hex'),
    request: Object.freeze(request),
    command: Object.freeze({ ...command, args: Object.freeze([...command.args]) })
  })
  const authority = await input.authorize(invocation)
  if (!authority || !authority.isCurrent() || authority.signal.aborted) {
    return { kind: 'refused', reason: 'approval-required' }
  }
  if (input.signal?.aborted) {
    return { kind: 'refused', reason: 'cancelled' }
  }
  let result: Awaited<ReturnType<typeof runProcess>>
  const signal = input.signal ? AbortSignal.any([input.signal, authority.signal]) : authority.signal
  try {
    result = await runProcess({
      program: command.program,
      args: command.args,
      cwd,
      env,
      input: stdin,
      timeoutMs: command.timeoutSeconds * 1000,
      maxOutputBytes: ENVIRONMENT_RECIPE_OUTPUT_BYTES,
      killOnOutputLimit: true,
      signal,
      detached: process.platform !== 'win32',
      terminationBarrier: true
    })
  } catch {
    return { kind: 'unverifiable', reason: 'command-failed' }
  }
  if (!authority.isCurrent() || authority.signal.aborted) {
    return { kind: 'unverifiable', reason: 'authority-changed' }
  }
  if (input.signal?.aborted) {
    return { kind: 'unverifiable', reason: 'cancelled' }
  }
  if (result.outputTruncated) {
    return { kind: 'unverifiable', reason: 'output-limit' }
  }
  if (result.timedOut) {
    return { kind: 'unverifiable', reason: 'timeout' }
  }
  if (result.code !== 0) {
    return { kind: 'unverifiable', reason: 'command-failed' }
  }
  try {
    return { kind: 'completed', response: parseEnvironmentRecipeResponse(result.stdout, request) }
  } catch {
    return { kind: 'unverifiable', reason: 'invalid-response' }
  }
}
