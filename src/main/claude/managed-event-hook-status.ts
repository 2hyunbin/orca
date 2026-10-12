import {
  getSharedManagedScriptPath,
  type HookCommandConfig,
  type HooksConfig
} from '../agent-hooks/installer-utils'
import {
  getManagedEventHook,
  hasSameManagedHookInvocation,
  type ClaudeCompatibleHookSettings
} from './hook-settings'

/** Where the agent's orca-hook.exe copy lives; its file name selects the hook's agent profile. */
export function getWindowsNativeHookPath(settings: ClaudeCompatibleHookSettings): string | null {
  return settings.windowsNativeHookExecutable
    ? getSharedManagedScriptPath(`${settings.scriptBaseName}.exe`)
    : null
}

/**
 * Which planned events carry a current managed hook. Either Windows form counts: install()
 * registers the `.cmd` hook whenever the native exe cannot be placed.
 */
export function findManagedEventHooks(
  config: HooksConfig,
  eventNames: string[],
  scriptPath: string,
  settings: ClaudeCompatibleHookSettings
): { missing: string[]; presentCount: number; registeredNativeHookPath: string | null } {
  const missing: string[] = []
  let presentCount = 0
  let nativeHookRegistered = false
  const nativeHookPath = getWindowsNativeHookPath(settings)
  const expectedHook = (eventName: string, path: string | null): HookCommandConfig =>
    getManagedEventHook(eventName, scriptPath, settings, path)
  for (const eventName of eventNames) {
    const [scriptHook, nativeHook] = [null, nativeHookPath].map((path) =>
      expectedHook(eventName, path)
    )
    const definitions = config.hooks?.[eventName]
    const registered = Array.isArray(definitions)
      ? definitions.flatMap((definition) => definition.hooks ?? [])
      : []
    const isNative =
      !hasSameManagedHookInvocation(nativeHook, scriptHook) &&
      registered.some((hook) => hasSameManagedHookInvocation(hook, nativeHook))
    if (isNative || registered.some((hook) => hasSameManagedHookInvocation(hook, scriptHook))) {
      presentCount += 1
      nativeHookRegistered ||= isNative
    } else {
      missing.push(eventName)
    }
  }
  return {
    missing,
    presentCount,
    registeredNativeHookPath: nativeHookRegistered ? nativeHookPath : null
  }
}
