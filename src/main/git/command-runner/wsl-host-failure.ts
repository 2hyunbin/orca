import type { ResolvedCommand } from './wsl-command-resolution'

/** wsl.exe's own launch-failure exit, distinct from any status the guest process can return. */
export const WSL_HOST_FAILURE_EXIT_CODE = 0xffffffff

function outputText(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  return Buffer.isBuffer(value) ? value.toString('utf8') : ''
}

/** Decode WSL launch diagnostics from stdout, stripping UTF-16LE NULs when WSL_UTF8 was ignored. */
export function readWslHostFailureDiagnostic(
  error: unknown,
  command: ResolvedCommand
): string | null {
  if (!command.wsl || !error || typeof error !== 'object') {
    return null
  }
  const { code, status, stdout, stderr } = error as {
    code?: unknown
    status?: unknown
    stdout?: unknown
    stderr?: unknown
  }
  const exitCode = typeof code === 'number' ? code : typeof status === 'number' ? status : null
  // Recognize the host launch-failure shape without reclassifying guest stderr.
  if (exitCode !== WSL_HOST_FAILURE_EXIT_CODE || outputText(stderr).trim().length > 0) {
    return null
  }
  const diagnostic = outputText(stdout).replaceAll('\u0000', '').trim()
  return diagnostic.length > 0 ? diagnostic : 'wsl.exe reported no diagnostic.'
}

/** Put WSL launch diagnostics in the message recorded by git.exec; preserve guest errors. */
export function annotateWslHostFailure(error: unknown, command: ResolvedCommand): unknown {
  const diagnostic = readWslHostFailureDiagnostic(error, command)
  if (diagnostic === null || !(error instanceof Error) || !command.wsl) {
    return error
  }
  const distro = command.wsl.distro
  error.message = `wsl.exe host failure (distro "${distro}"): ${diagnostic}\n${error.message}`
  return Object.assign(error, { wslHostFailure: true, wslDistro: distro })
}

// Measured on a cold systemd distro: concurrent first launches intermittently fail before the
// guest command starts; a retry a moment later succeeds once the distro is up.
const TRANSIENT_WSL_SERVICE_ERROR = /Wsl\/Service\/E_UNEXPECTED\b/
const TRANSIENT_WSL_SERVICE_RETRY_DELAYS_MS = [250, 750, 1500] as const

/** wsl.exe failed before the guest ran, with an error the WSL service recovers from by itself. */
export function isTransientWslServiceFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('wslHostFailure' in error)) {
    return false
  }
  return error instanceof Error && TRANSIENT_WSL_SERVICE_ERROR.test(error.message)
}

/**
 * Re-runs a read whose wsl.exe launch hit a transient service error. Reads only: the guest never
 * started, but a write must not risk running twice on a host that reports failure late.
 */
export async function retryTransientWslServiceFailure<T>(
  run: () => Promise<T>,
  options: { retryable: boolean; signal?: AbortSignal; delaysMs?: readonly number[] }
): Promise<T> {
  const delays = options.delaysMs ?? TRANSIENT_WSL_SERVICE_RETRY_DELAYS_MS
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      const delay = delays[attempt]
      if (
        !options.retryable ||
        delay === undefined ||
        options.signal?.aborted ||
        !isTransientWslServiceFailure(error)
      ) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}
