import type { TerminalOscLinkRange } from '../../../../shared/terminal-osc-link-ranges'
import { parseTerminalKittyKeyboardFlags } from '../../../../shared/terminal-kitty-keyboard-flags'

import type { RuntimeTerminalOutputOwner } from './terminal-output-owner'

export async function serializeHeadlessTerminalBuffer(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  opts: { scrollbackRows?: number; includeEmpty?: boolean } = {}
): Promise<{
  data: string
  cols: number
  rows: number
  cwd?: string | null
  lastTitle?: string
  seq?: number
  source?: 'headless'
  oscLinks?: TerminalOscLinkRange[]
  alternateScreen?: boolean
  scrollbackAnsi?: string
  kittyKeyboardFlags?: number
  terminalOwner?: 'shell'
  // Why: dangling mid-escape tail the restorer must write LAST, after any
  // reset, so the next live chunk completes it instead of rendering it
  // literally (Bug E / #7329).
  pendingEscapeTailAnsi?: string
} | null> {
  const state = output.headlessTerminals.get(ptyId)
  if (!state) {
    return null
  }
  await state.writeChain
  await state.ownership.settle()
  // Why: normal history is separated from an active alternate frame, so the
  // caller's scrollback policy can be honored without painting it into alt.
  const scrollbackRows = opts.scrollbackRows ?? 0
  const snapshot = state.emulator.getSnapshot({ scrollbackRows })
  const terminalOwner = state.ownership.owner
  const data = snapshot.rehydrateSequences + snapshot.snapshotAnsi
  return data.length > 0 || opts.includeEmpty === true
    ? output.host.preferTrackedLastTitle(ptyId, {
        data,
        frameRestoreAnsi: snapshot.frameRestoreAnsi,
        cols: snapshot.cols,
        rows: snapshot.rows,
        cwd: snapshot.cwd ?? output.terminalCwdByPtyId.get(ptyId),
        lastTitle: snapshot.lastTitle,
        seq: state.outputSequence,
        source: 'headless' as const,
        oscLinks: snapshot.oscLinks,
        scrollbackAnsi: snapshot.scrollbackAnsi,
        // Why beside outputSequence and never re-read later: the flags must
        // describe the same stream position as the image, or replay would
        // apply push/pop transitions twice or out of order.
        ...(parseTerminalKittyKeyboardFlags(snapshot.modes?.kittyKeyboardFlags) !== undefined
          ? { kittyKeyboardFlags: snapshot.modes.kittyKeyboardFlags }
          : {}),
        ...(snapshot.pendingEscapeTailAnsi
          ? { pendingEscapeTailAnsi: snapshot.pendingEscapeTailAnsi }
          : {}),
        ...(terminalOwner ? { terminalOwner } : {}),
        // Why: lets the renderer skip the destructive scrollback clear when
        // restoring an alt-screen snapshot — clearing wipes xterm's own
        // history that the TUI relies on for scroll-up after a tab return.
        alternateScreen: snapshot.modes?.alternateScreen ?? state.emulator.isAlternateScreen,
        // Why NOT folded into data: the renderer writes its post-replay
        // reset after data, and any ESC after a dangling partial aborts it.
        // The restorer writes this last (Bug E fix).
        pendingEscapeTailAnsi: snapshot.pendingEscapeTailAnsi
      })
    : null
}

export function disposeHeadlessTerminal(output: RuntimeTerminalOutputOwner, ptyId: string): void {
  output.headlessHydrationState.delete(ptyId)
  const state = output.headlessTerminals.get(ptyId)
  if (!state) {
    return
  }
  output.headlessTerminals.delete(ptyId)
  // Why: queued chain links still parse below before the emulator disposes;
  // sever the reply sink now so they cannot write to a respawned PTY that
  // reused this id (belt to the sink's state-identity check).
  state.emulator.disableQueryReplyForwarding()
  state.ownership.dispose()
  state.writeChain.finally(() => state.emulator.dispose()).catch(() => state.emulator.dispose())
}
