import type { SpawnedSourceControlAgentProcess } from './source-control-text-generation-types'

/** A bounded explicit stop supersedes natural completion, including an unconfirmed root exit. */
export async function sourceControlAgentCompletion(
  child: SpawnedSourceControlAgentProcess,
  termination: Promise<void> | null
): Promise<boolean> {
  if (termination) {
    await termination
    return true
  }
  return child.group ? child.group.exited : true
}
