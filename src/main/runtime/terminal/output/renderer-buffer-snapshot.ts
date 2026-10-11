import type { TerminalOscLinkRange } from '../../../../shared/terminal-osc-link-ranges'

import type { RuntimeTerminalOutputOwner } from './terminal-output-owner'

export async function serializeRendererTerminalBuffer(
  output: RuntimeTerminalOutputOwner,
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
  if (output.host.ptyController?.hasRendererSerializer?.(ptyId) === false) {
    return null
  }
  let rendererSnapshot: {
    data: string
    cols: number
    rows: number
    seq?: number
    cwd?: string | null
    lastTitle?: string
    oscLinks?: TerminalOscLinkRange[]
    pendingEscapeTailAnsi?: string
    kittyKeyboardFlags?: number
  } | null = null
  try {
    rendererSnapshot = await (output.host.ptyController?.serializeBuffer?.(ptyId, {
      scrollbackRows: opts.scrollbackRows
    }) ?? Promise.resolve(null))
  } catch {
    // Why: terminal snapshots should not depend on a mounted renderer pane.
    // If renderer serialization races reload/unmount, callers can still use
    // their existing null fallback paths.
  }
  return rendererSnapshot
    ? output.host.preferTrackedLastTitle(ptyId, {
        ...rendererSnapshot,
        cwd: rendererSnapshot.cwd ?? output.terminalCwdByPtyId.get(ptyId),
        source: 'renderer' as const,
        ...(rendererSnapshot.pendingEscapeTailAnsi
          ? { pendingEscapeTailAnsi: rendererSnapshot.pendingEscapeTailAnsi }
          : {})
      })
    : null
}
