import { describe, expect, it } from 'vitest'
import type { FocusClickSuppressionInput } from './pane-focus-click-suppression'
import { shouldSwallowFocusClick } from './pane-focus-click-suppression'

// A plain left click with a mouse on an unfocused, mouse-tracking terminal.
const FOCUSING_CLICK: FocusClickSuppressionInput = {
  terminalHadFocus: false,
  focusesTerminal: true,
  mouseTrackingMode: 'vt200',
  pointerType: 'mouse',
  isPrimaryPointer: true,
  button: 0,
  modifierHeld: false
}

describe('shouldSwallowFocusClick', () => {
  it('swallows the click that focuses a terminal running a mouse-aware TUI', () => {
    expect(shouldSwallowFocusClick(FOCUSING_CLICK)).toBe(true)
  })

  it.each([
    { override: { terminalHadFocus: true }, why: 'terminal already focused' },
    { override: { mouseTrackingMode: 'none' }, why: 'no mouse tracking' },
    { override: { focusesTerminal: false }, why: 'not headed for the terminal' },
    { override: { pointerType: 'touch' }, why: 'touch pointer' },
    { override: { isPrimaryPointer: false }, why: 'secondary pointer' },
    { override: { button: 2 }, why: 'right button' },
    { override: { modifierHeld: true }, why: 'modifier held' }
  ])('leaves the click alone — $why', ({ override }) => {
    expect(shouldSwallowFocusClick({ ...FOCUSING_CLICK, ...override })).toBe(false)
  })
})
