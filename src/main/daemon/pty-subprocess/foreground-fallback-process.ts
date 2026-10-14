import { win32 as pathWin32 } from 'node:path'

// Why: they run before the shell execs, for up to a few hundred ms when many terminals start.
const LINUX_TERMINAL_SCOPE_WRAPPERS = new Set(['systemd-run', 'env'])

function normalizeForegroundProcessName(processName: string | null | undefined): string | null {
  const trimmed = processName?.trim().replace(/^["']|["']$/g, '') ?? ''
  if (!trimmed || trimmed === 'xterm-256color') {
    return null
  }
  const name = trimmed.split(/[\\/]/).pop() || null
  return process.platform === 'linux' && name && LINUX_TERMINAL_SCOPE_WRAPPERS.has(name)
    ? null
    : name
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
