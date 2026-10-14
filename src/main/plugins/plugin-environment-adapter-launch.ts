import {
  environmentCommandInput,
  type EnvironmentCommandInvocation,
  type EnvironmentCommandLaunch
} from './plugin-environment-command-execution'
import type { PluginEnvironmentRecipeRegistration } from './plugin-environment-recipe-registry'
import type { PluginRecipeAuthority } from './plugin-recipe-artifact-registry'
import type { PluginEnvironmentRecipe } from '../../shared/plugins/plugin-environment-recipe-artifact'

export type EnvironmentAdapterRuntime = (signal: AbortSignal) => Promise<string>

const bootstrap = `import{Readable}from'node:stream';
const fail=()=>{process.stderr.write('Environment adapter failed.\\n');process.exit(1)};
process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
try{let input='';for await(const chunk of process.stdin)input+=chunk;
const envelope=JSON.parse(input);process.argv.splice(1,0,envelope.entry);
Object.defineProperty(process,'stdin',{value:Readable.from([envelope.stdin])});
await import('data:text/javascript;base64,'+Buffer.from(envelope.source).toString('base64'));
}catch{fail()}`

export async function prepareEnvironmentAdapterLaunch(input: {
  authority: PluginRecipeAuthority<PluginEnvironmentRecipe>
  invocation: EnvironmentCommandInvocation<object>
  runtime: EnvironmentAdapterRuntime
  signal: AbortSignal
}): Promise<EnvironmentCommandLaunch | undefined> {
  const { authority, invocation, signal } = input
  if (!('entry' in invocation.command)) {
    return undefined
  }
  const recipe: PluginEnvironmentRecipeRegistration['recipe'] = authority.registration.recipe
  const command =
    invocation.action === 'inspect-operation'
      ? recipe.recovery?.command
      : Object.entries(recipe.commands).find(([action]) => action === invocation.action)?.[1]
  if (!command || JSON.stringify(command) !== JSON.stringify(invocation.command)) {
    throw new Error('The adapter command differs from the current reviewed recipe')
  }
  signal.throwIfAborted()
  const source = await authority.readArtifact(invocation.command.entry)
  const program = await input.runtime(signal)
  signal.throwIfAborted()
  if (!authority.isCurrent()) {
    throw new Error('Environment adapter authority changed during preparation')
  }
  return {
    program,
    args: [
      '--max-old-space-size=128',
      '--input-type=module',
      '--eval',
      bootstrap,
      '--',
      ...command.args
    ],
    input: JSON.stringify({
      entry: invocation.command.entry,
      source,
      stdin: environmentCommandInput(invocation.request).stdin
    })
  }
}
