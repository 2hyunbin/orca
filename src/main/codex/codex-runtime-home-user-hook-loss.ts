import {
  createManagedCommandMatcher,
  readHooksJson,
  removeManagedCommands,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import { getConfigPath } from './codex-hook-definition'
import { getCodexManagedScriptFileName } from './codex-hook-identity'
import { getRuntimeHooksWithSystemUserHooks } from './codex-hook-user-mirroring'

function definitionKeys(
  hooks: Record<string, HookDefinition[]>,
  isManaged: (command: string | undefined) => boolean
): string[] {
  const keys: string[] = []
  for (const [eventName, definitions] of Object.entries(hooks)) {
    // Why: hooks.json is user-edited; a non-array event value is skipped, as the install skips it.
    if (!Array.isArray(definitions)) {
      continue
    }
    for (const definition of removeManagedCommands(definitions, isManaged)) {
      keys.push(`${eventName}\0${JSON.stringify(definition)}`)
    }
  }
  return keys
}

/**
 * Whether the launch-prep install, which rebuilds a managed home's user hooks from ~/.codex,
 * would drop a user hook that only `runtimeHomePath` holds.
 */
export function runtimeHomeHasUnmirroredUserHooks(runtimeHomePath: string): boolean {
  const configPath = getConfigPath(runtimeHomePath)
  const hooks = readHooksJson(configPath)?.hooks
  if (!hooks) {
    return false
  }
  const isManaged = createManagedCommandMatcher(getCodexManagedScriptFileName())
  const mirrored = getRuntimeHooksWithSystemUserHooks(hooks, isManaged, configPath)
  if (!mirrored) {
    // The install refuses to rebuild from an unreadable ~/.codex too.
    return false
  }
  const kept = new Set(definitionKeys(mirrored.hooks, isManaged))
  return definitionKeys(hooks, isManaged).some((key) => !kept.has(key))
}
