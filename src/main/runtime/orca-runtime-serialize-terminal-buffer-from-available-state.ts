import { OrcaRuntimeWithCreatePtyHeadlessTerminalState } from './orca-runtime-create-pty-headless-terminal-state'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { PtyProviderBufferSnapshot } from '../providers/types'

export class OrcaRuntimeWithSerializeTerminalBufferFromAvailableState extends OrcaRuntimeWithCreatePtyHeadlessTerminalState {
  protected serializeTerminalBufferFromAvailableState(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<{
    data: string
    frameRestoreAnsi?: string
    cols: number
    rows: number
    cwd?: string | null
    lastTitle?: string
    seq?: number
    source?: 'headless' | 'renderer'
    oscLinks?: TerminalOscLinkRange[]
    alternateScreen?: boolean
    pendingEscapeTailAnsi?: string
    kittyKeyboardFlags?: number
    terminalOwner?: 'shell'
  } | null> {
    return this.terminalOutput.serializeTerminalBufferFromAvailableState(ptyId, opts)
  }

  protected serializePreferredRestoredTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ) {
    return this.terminalOutput.serializePreferredRestoredTerminalBuffer(ptyId, opts)
  }

  serializeRendererTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<{
    data: string
    frameRestoreAnsi?: string
    cols: number
    rows: number
    seq?: number
    cwd?: string | null
    lastTitle?: string
    source?: 'renderer'
    oscLinks?: TerminalOscLinkRange[]
    pendingEscapeTailAnsi?: string
    kittyKeyboardFlags?: number
  } | null> {
    return this.terminalOutput.serializeRendererTerminalBuffer(ptyId, opts)
  }

  protected serializeProviderTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {},
    wait: { timeoutMs?: number; retireOnTimeout?: boolean } = {}
  ): Promise<PtyProviderBufferSnapshot | null> {
    return this.terminalOutput.serializeProviderTerminalBuffer(ptyId, opts, wait)
  }
}
