import { PROCESS_BOUNDARY_GROUND } from '../../../../shared/terminal-mode-reset-profiles'
import type { RuntimeTerminalOutputOwner } from './terminal-output-owner'

export function resizeHeadlessTerminal(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  cols: number,
  rows: number
): void {
  const state = output.headlessTerminals.get(ptyId)
  if (!state) {
    return
  }
  const unpainted = state.unrepaintedReflowGrid
  // Why: a PTY resize off the reflowed grid makes the TUI repaint; an echo of it does not.
  if (unpainted && (unpainted.cols !== cols || unpainted.rows !== rows)) {
    state.unrepaintedReflowGrid = undefined
  }
  // Why: terminal reflow is a parser operation. It must sit in the same
  // per-PTY stream as output bytes or restore snapshots can bake in wraps
  // from the wrong terminal width.
  state.writeChain = state.writeChain
    .then(() => {
      state.emulator.resize(cols, rows)
    })
    .catch(() => {
      // Best-effort mirror tracking; live PTY streaming must continue even
      // if xterm rejects a raced resize during teardown.
    })
}

export function reflowHeadlessTerminalToPtyGrid(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  cols: number,
  rows: number
): void {
  if (cols <= 0 || rows <= 0) {
    return
  }
  const state = output.headlessTerminals.get(ptyId)
  if (!state) {
    return
  }
  const applied = state.emulator.getAppliedSize()
  output.host.resizeHeadlessTerminal(ptyId, cols, rows)
  // Why: nothing resized the PTY, so the TUI does not repaint and its cells keep the old grid.
  if (applied.cols !== cols || applied.rows !== rows) {
    state.unrepaintedReflowGrid = { cols, rows }
  }
}

export async function clearHeadlessTerminalBuffer(
  output: RuntimeTerminalOutputOwner,
  ptyId: string
): Promise<void> {
  const state = output.headlessTerminals.get(ptyId)
  if (!state) {
    return
  }
  // Why: headless writes are queued to preserve xterm parser order. Clear
  // must join that same chain or an earlier PTY chunk can finish after the
  // clear request and repopulate mobile scrollback.
  state.writeChain = state.writeChain.then(() => state.emulator.clearScrollback())
  await state.writeChain
}

export async function resetHeadlessTerminalInputModes(
  output: RuntimeTerminalOutputOwner,
  ptyId: string
): Promise<void> {
  // Why now, not on the chain: onPtyData scans live bytes into these on arrival.
  // Focus is outside their model, so the plain ground is exact.
  output.host.scanProviderModeTrackers(ptyId, PROCESS_BOUNDARY_GROUND)
  const state = output.headlessTerminals.get(ptyId)
  if (!state) {
    return
  }
  // Why on the chain: the ground must land after every PTY chunk already queued.
  const completion = state.writeChain.then(async () => {
    await state.emulator.write(state.ownership.groundInputModes())
  })
  state.writeChain = completion.catch(() => {})
  await completion
}
