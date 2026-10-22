import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_CREATED_SERVER_TAB_HOLDS,
  noteDesktopCreatedServerTab
} from './desktop-created-server-tabs'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

describe('the desktop-created server tab record in a switch-off build', () => {
  it('writes nothing to this desktop’s storage', () => {
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { getItem: () => null, setItem, removeItem: vi.fn() })
    noteDesktopCreatedServerTab('web-env-1', 'repo::/worktree', 'simulator-1')
    // Presence: the call recorded the tab in memory.
    expect(DESKTOP_CREATED_SERVER_TAB_HOLDS.isTabHeld('repo::/worktree', 'simulator-1')).toBe(true)
    expect(setItem).not.toHaveBeenCalled()
  })
})
