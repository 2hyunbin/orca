import { expect, it } from 'vitest'
import { readDesktopAwayState } from './desktop-away-state'

it('treats a windowless sending host as away without changing the visible-window idle rule', () => {
  const active = { getSystemIdleState: () => 'active', getSystemIdleTime: () => 0 }
  expect(readDesktopAwayState(active, false)).toBe(true)
  expect(readDesktopAwayState(active, true)).toBe(false)
})
