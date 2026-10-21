import type { PaneLaunchAgentPaneSlice } from './pane-launch-agent-candidate'
import type { TerminalAgent } from '../../../../../shared/terminal-agent'
import type { RecognizedAgentProcess } from '../../../../../shared/agent-process-recognition'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'

export type TerminalForegroundServices = {
  paneKey: string
  worktreeId: string
  tabId: string
  cwd: string
  startup: PaneLaunchAgentPaneSlice['startup']
  getPtyId: () => string | null
  getExpectedIncarnationId: () => string | null
  isVisible: () => boolean
  getCommandInferredAgent: () => TerminalAgent | null
  observeForegroundAgentProcess: (process: RecognizedAgentProcess) => void
  onConfirmedShellForeground: (reason: 'command-finished' | 'visible-pty' | 'process-exit') => void
  clearCommandInferredPaneAgentAfterPtySideEffects: () => void
  flushPendingInterruptInference: () => boolean | Promise<boolean>
  dropCommandFinishedStatusIfSameTurn: (
    entry: AgentStatusEntry | undefined,
    options?: { allowInferredInterrupt?: boolean }
  ) => void
}
