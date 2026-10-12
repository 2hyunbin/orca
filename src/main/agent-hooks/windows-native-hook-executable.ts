import { join } from 'node:path'

/** The packaged binary (native/windows-agent-hook), installed under the same name. */
export const WINDOWS_CLAUDE_HOOK_EXECUTABLE_NAME = 'claude-hook.exe'

/**
 * Where this app ships the Claude hook binary, or null off Windows and in orcad. Dev checkouts
 * resolve a path with no file there, so the install's read fails and Claude keeps the `.cmd` hook.
 */
export function resolveBundledWindowsNativeHookExecutable(): string | null {
  // Narrowed rather than typed: the CLI build compiles this without Electron's Process type.
  const resourcesPath = 'resourcesPath' in process ? process.resourcesPath : undefined
  return process.platform === 'win32' && typeof resourcesPath === 'string' && resourcesPath
    ? join(resourcesPath, 'bin', WINDOWS_CLAUDE_HOOK_EXECUTABLE_NAME)
    : null
}
