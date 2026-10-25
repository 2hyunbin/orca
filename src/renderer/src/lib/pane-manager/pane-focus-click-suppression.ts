export type FocusClickSuppressionInput = {
  /** Whether this pane's xterm textarea held keyboard focus when the gesture began. */
  terminalHadFocus: boolean
  /** False when the pointer landed on a pane-local app control rather than the terminal. */
  focusesTerminal: boolean
  mouseTrackingMode: string
  pointerType: string
  isPrimaryPointer: boolean
  button: number
  /** Any of shift/meta/ctrl/alt — every one of them is a deliberate bypass. */
  modifierHeld: boolean
}

/**
 * Whether a click that only gives the terminal keyboard focus should stop before
 * xterm turns it into a mouse report (e.g. answering an agent's prompt row).
 */
export function shouldSwallowFocusClick(input: FocusClickSuppressionInput): boolean {
  if (input.terminalHadFocus || !input.focusesTerminal) {
    return false
  }
  // Why: without tracking the click only places the cursor or starts a selection.
  if (input.mouseTrackingMode === 'none') {
    return false
  }
  // Why: touch/pen may never emit the compat mousedown, leaving the arm for a later real click.
  if (input.pointerType !== 'mouse' || !input.isPrimaryPointer) {
    return false
  }
  // Why: middle/right buttons and modifier clicks are deliberate (paste, menu, force-selection).
  return input.button === 0 && !input.modifierHeld
}
