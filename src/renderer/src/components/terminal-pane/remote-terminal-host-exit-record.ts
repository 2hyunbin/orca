import type { RuntimeTerminalSummary } from '../../../../shared/runtime-types'

type HostTerminalExitFacts = Partial<
  Pick<RuntimeTerminalSummary, 'verdict' | 'exitCause' | 'connected'>
>

/**
 * True only when the execution host itself recorded this terminal's exit. A host's verdict wins;
 * a host that predates the verdict still counts when it holds an exit cause for a terminal it
 * reports disconnected. Anything else (no answer, unverifiable, an older host) proves nothing.
 */
export function hostRecordsTerminalExit(
  terminal: HostTerminalExitFacts | null | undefined
): boolean {
  if (!terminal) {
    return false
  }
  if (terminal.verdict !== undefined) {
    return terminal.verdict === 'exited'
  }
  return Boolean(terminal.exitCause) && terminal.connected === false
}
