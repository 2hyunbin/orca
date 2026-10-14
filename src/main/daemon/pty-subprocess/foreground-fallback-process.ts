import { win32 as pathWin32 } from 'node:path'
import { isTerminalScopeWrapper } from '../terminal-scopes-runtime'

function normalizeForegroundProcessName(processName: string | null | undefined): string | null {
  const trimmed = processName?.trim().replace(/^["']|["']$/g, '') ?? ''
  // Why the wrappers: they own a new Linux terminal until its shell execs, for up to a few
  // hundred ms when many terminals start; node-pty reports their exact argv[0] there.
  if (!trimmed || trimmed === 'xterm-256color' || isTerminalScopeWrapper(trimmed)) {
    return null
  }
  return trimmed.split(/[\\/]/).pop() || null
}

/**
 * node-pty's reported foreground name, normalized to a bare executable.
 * Windows ConPTY can report nothing useful; fall back to the spawned shell.
 */
export function resolveFallbackForegroundProcess(
  processName: string | null | undefined,
  shellPath: string
): string | null {
  const normalized = normalizeForegroundProcessName(processName)
  if (normalized || process.platform !== 'win32') {
    return normalized
  }
  return normalizeForegroundProcessName(pathWin32.basename(shellPath))
}
