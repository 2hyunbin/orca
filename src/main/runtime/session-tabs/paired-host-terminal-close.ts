import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import type { RuntimeTerminalClose } from '../../../shared/runtime-types'

const PAIRED_HOST_TERMINAL_CLOSE_TIMEOUT_MS = 15_000

export type PairedHostTerminal = { environmentId: string; handle: string }

export type PairedHostTerminalCall = (
  environmentId: string,
  method: 'terminal.close' | 'terminal.closeTab',
  params: { terminal: string },
  timeoutMs: number
) => Promise<unknown>

/** The paired runtime that runs this PTY, or null when the PTY is not a paired runtime's. */
export function getPairedHostTerminal(ptyId: string | null | undefined): PairedHostTerminal | null {
  const parsed = ptyId ? parseRemoteRuntimePtyId(ptyId) : null
  const environmentId = parsed?.environmentId?.trim()
  return parsed && environmentId && parsed.handle ? { environmentId, handle: parsed.handle } : null
}

function readHostClose(result: unknown): Omit<RuntimeTerminalClose, 'handle' | 'tabId'> | null {
  const close =
    typeof result === 'object' && result !== null && 'close' in result ? result.close : null
  if (typeof close !== 'object' || close === null || !('ptyKilled' in close)) {
    return null
  }
  if (typeof close.ptyKilled !== 'boolean') {
    return null
  }
  const verdict = 'ptyStopVerdict' in close ? close.ptyStopVerdict : undefined
  const reason = 'ptyStopReason' in close ? close.ptyStopReason : undefined
  return {
    ptyKilled: close.ptyKilled,
    ...(verdict === 'live' || verdict === 'unverifiable' ? { ptyStopVerdict: verdict } : {}),
    ...(typeof reason === 'string' ? { ptyStopReason: reason } : {}),
    ...('pendingKillRecorded' in close && close.pendingKillRecorded === true
      ? { pendingKillRecorded: true as const }
      : {})
  }
}

function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? typeof error.code === 'string'
      ? error.code
      : null
    : null
}

/**
 * Asks the paired runtime that owns the PTY to close it. This machine cannot stop that process,
 * so the owner's receipt is the only evidence of the stop. Resolves 'absent' when the owner
 * answers it has no such terminal; any other failure rejects, so the caller keeps its local
 * mirror rather than hiding a terminal that may still run.
 */
export async function closeTerminalOnPairedHost(
  call: PairedHostTerminalCall,
  terminal: PairedHostTerminal,
  method: 'terminal.close' | 'terminal.closeTab'
): Promise<Omit<RuntimeTerminalClose, 'handle' | 'tabId'> | 'absent'> {
  let result: unknown
  try {
    result = await call(
      terminal.environmentId,
      method,
      { terminal: terminal.handle },
      PAIRED_HOST_TERMINAL_CLOSE_TIMEOUT_MS
    )
  } catch (error) {
    if (errorCode(error) === 'terminal_not_found') {
      return 'absent'
    }
    throw error
  }
  const close = readHostClose(result)
  if (!close) {
    // Why unverifiable: the owner answered, but not with a receipt this build can read.
    return {
      ptyKilled: false,
      ptyStopVerdict: 'unverifiable',
      ptyStopReason: 'its owning host returned no close receipt'
    }
  }
  return close
}
