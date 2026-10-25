import type { OrcaRuntimeService } from '../../../orca-runtime'
import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT } from '../../../../../shared/terminal-scrollback-policy'
import type { TerminalOscLinkRange } from '../../../../../shared/terminal-osc-link-ranges'

type ModelSeed = {
  data: string
  cols: number
  rows: number
  seq?: number
  cwd?: string | null
  oscLinks?: TerminalOscLinkRange[]
}

type RendererBufferSource = Pick<
  OrcaRuntimeService,
  'getPtyOutputSequence' | 'serializeRendererTerminalBuffer'
>

/**
 * Main's model also repaints desktop panes on reveal, so seed it at desktop depth rather than from
 * the phone-sized (or byte-budget-emptied) snapshot; fall back when the renderer moved past that seq.
 */
export async function desktopDepthModelSeed<T extends ModelSeed>(
  runtime: RendererBufferSource,
  ptyId: string,
  phoneSnapshot: T
): Promise<ModelSeed> {
  if (typeof phoneSnapshot.seq !== 'number') {
    return phoneSnapshot
  }
  const outputSequenceBefore = runtime.getPtyOutputSequence(ptyId)
  const desktop = await runtime.serializeRendererTerminalBuffer(ptyId, {
    scrollbackRows: DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT
  })
  return desktop?.data &&
    desktop.seq === phoneSnapshot.seq &&
    runtime.getPtyOutputSequence(ptyId) === outputSequenceBefore
    ? desktop
    : phoneSnapshot
}
