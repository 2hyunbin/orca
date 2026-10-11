import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import { resolveWslInteropSpawnCwd } from './wsl-interop-spawn-directory'

/** A host-side `wsl.exe` call (`--list`, `--status`, `-d <distro> --exec ...`). */
export function wslExeProcessSpec(
  args: readonly string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv
): ProcessSpec {
  // Why an explicit cwd (#16463): an inherited one can be a deleted worktree, which
  // makes every spawn fail ENOENT and reads as "WSL is not installed".
  return { program: 'wsl.exe', args, env, timeoutMs, cwd: resolveWslInteropSpawnCwd() }
}

export type WslExeExitError = Error & { code: number | string | null; status: number | null }

/**
 * Null for a clean exit; otherwise the execFile-shaped error the WSL probes classify.
 *
 * Why both `code` and `status`: the probe caches read a numeric exit from either field as
 * a definitive answer, and `ETIMEDOUT` (like a signal kill) as a retryable one.
 */
export function wslExeExitError(result: ProcessResult): WslExeExitError | null {
  if (result.code === 0) {
    return null
  }
  if (result.timedOut) {
    return Object.assign(new Error('wsl.exe timed out'), { code: 'ETIMEDOUT', status: null })
  }
  return Object.assign(new Error(`wsl.exe exited with code ${result.code ?? result.signal}`), {
    code: result.code,
    status: result.code
  })
}

/** Stdout of a clean exit; throws for any other outcome, as execFile did. */
export function wslExeStdout(result: ProcessResult): string {
  const error = wslExeExitError(result)
  if (error) {
    throw error
  }
  return result.stdout
}
