import { createHash } from 'node:crypto'
import { runProcess } from '@orca/process-host'
import {
  ENVIRONMENT_RECIPE_INPUT_BYTES,
  ENVIRONMENT_RECIPE_OUTPUT_BYTES
} from '../../shared/environment-recipe-protocol'
import type { ReadonlyEnvironmentRecipeCommand } from '../../shared/plugins/plugin-environment-recipe-artifact'
import type {
  EnvironmentCommandExecutionResult,
  EnvironmentCommandUnverifiableReason
} from '../../shared/plugins/plugin-environment-recipe-result'

export type EnvironmentCommandInvocation<T extends object> = Readonly<{
  pluginKey: string
  providerId: string
  operationId: string
  action: string
  recipeDigest: string
  requestDigest: string
  command: ReadonlyEnvironmentRecipeCommand
  request: Readonly<T>
}>
export type EnvironmentCommandLaunch = {
  program: string
  args: readonly string[]
  input: string
}
export type EnvironmentCommandAuthority = {
  isCurrent(): boolean
  signal: AbortSignal
  launch?: EnvironmentCommandLaunch
}
export function environmentCommandInput(request: object): { stdin: string; requestDigest: string } {
  const stdin = `${JSON.stringify(request)}\n`
  if (Buffer.byteLength(stdin) > ENVIRONMENT_RECIPE_INPUT_BYTES) {
    throw new Error('Environment recipe request exceeds its byte limit')
  }
  return { stdin, requestDigest: createHash('sha256').update(stdin).digest('hex') }
}

export async function executeReviewedEnvironmentCommand<T extends object, R>(input: {
  invocation: EnvironmentCommandInvocation<T>
  stdin: string
  cwd: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  authorize(
    invocation: EnvironmentCommandInvocation<T>
  ): Promise<EnvironmentCommandAuthority | null>
  parseResponse(stdout: string, request: T): R
  rejectResponse?(response: R): EnvironmentCommandUnverifiableReason | null
}): Promise<EnvironmentCommandExecutionResult<R>> {
  const { invocation, stdin, cwd } = input
  const command = { ...invocation.command, args: [...invocation.command.args] }
  const env = { ...input.env }
  const authority = await input.authorize(invocation)
  if (input.signal?.aborted) {
    return { kind: 'refused', reason: 'cancelled' }
  }
  const portable = 'entry' in command
  if (portable && !authority?.launch) {
    return { kind: 'refused', reason: 'approval-required' }
  }
  if (!authority || !authority.isCurrent() || authority.signal.aborted) {
    return { kind: 'refused', reason: 'approval-required' }
  }
  const signal = input.signal ? AbortSignal.any([input.signal, authority.signal]) : authority.signal
  const launch = portable ? authority.launch : undefined
  if (portable) {
    delete env.NODE_OPTIONS
    delete env.NODE_PATH
    delete env.ELECTRON_RUN_AS_NODE
  }
  let result: Awaited<ReturnType<typeof runProcess>>
  try {
    result = await runProcess({
      program: launch?.program ?? command.program,
      args: launch ? [...launch.args] : command.args,
      cwd,
      env,
      input: launch?.input ?? stdin,
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
    const response = input.parseResponse(result.stdout, invocation.request)
    const rejected = input.rejectResponse?.(response)
    return rejected ? { kind: 'unverifiable', reason: rejected } : { kind: 'completed', response }
  } catch {
    return { kind: 'unverifiable', reason: 'invalid-response' }
  }
}
