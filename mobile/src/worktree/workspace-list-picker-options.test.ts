import { describe, expect, it } from 'vitest'
import {
  workspaceOptionsAccessibilityLabel,
  workspaceOptionsChipLabel
} from './workspace-list-picker-options'

describe('the Workspace options chip', () => {
  it("uses the desktop's name, with the active-filter count when there is one", () => {
    expect(workspaceOptionsChipLabel(0)).toBe('Workspace options')
    expect(workspaceOptionsChipLabel(2)).toBe('Workspace options (2)')
  })

  it("reads to screen readers as the desktop's trigger does", () => {
    expect(workspaceOptionsAccessibilityLabel(0)).toBe('Workspace options')
    expect(workspaceOptionsAccessibilityLabel(1)).toBe('Workspace options (1 filter active)')
    expect(workspaceOptionsAccessibilityLabel(3)).toBe('Workspace options (3 filters active)')
  })
})
