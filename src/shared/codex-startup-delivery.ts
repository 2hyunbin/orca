import { someCommandLineToken } from './agent-command-line-entrypoint'
import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'
import { shellReadyMarkerComesFromLineEditor } from './shell-ready-marker-timing'

export type StartupCommandDelivery = 'fast' | 'shell-ready'

export function hasCodexNativeDraftFlag(command: string | null | undefined): boolean {
  if (recognizeAgentProcessFromCommandLine(command)?.agent !== 'codex' || !command) {
    return false
  }
  return someCommandLineToken(
    command,
    (value, startsQuoted, index) =>
      index > 0 && !startsQuoted && (value === '--prefill' || value.startsWith('--prefill='))
  )
}

export function isCodexStartupCommand(command: string | null | undefined): boolean {
  return recognizeAgentProcessFromCommandLine(command)?.agent === 'codex'
}

export function shouldUseShellReadyStartupDelivery(args: {
  command: string | null | undefined
  startupCommandDelivery?: StartupCommandDelivery
  /** The shell that will run the command, when the deciding side knows it. Plain Codex
   *  waits for the handshake on shells that publish the marker from their line editor:
   *  there the wait ends at the prompt, while an early write double-echoes the launch. */
  shellPath?: string
}): boolean {
  return (
    args.startupCommandDelivery === 'shell-ready' ||
    hasCodexNativeDraftFlag(args.command) ||
    (args.shellPath !== undefined &&
      shellReadyMarkerComesFromLineEditor(args.shellPath) &&
      isCodexStartupCommand(args.command))
  )
}
