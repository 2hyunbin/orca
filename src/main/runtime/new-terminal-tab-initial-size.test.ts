import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { resolveNewTerminalTabSize } from './new-terminal-tab-initial-size'

function snapshotWithActivePane(ptyId: string | null): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: 'wt-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: 'tab-1::leaf-1',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'tab-0::leaf-0',
        parentTabId: 'tab-0',
        leafId: 'leaf-0',
        ptyId: 'pty-inactive',
        title: 'Other',
        isActive: false
      },
      {
        type: 'terminal',
        id: 'tab-1::leaf-1',
        parentTabId: 'tab-1',
        leafId: 'leaf-1',
        ptyId,
        title: 'Active',
        isActive: true
      }
    ]
  }
}

const sizes = new Map([
  ['pty-active', { cols: 211, rows: 57 }],
  ['pty-inactive', { cols: 80, rows: 24 }]
])
const getSize = (ptyId: string): { cols: number; rows: number } | null => sizes.get(ptyId) ?? null

describe('resolveNewTerminalTabSize', () => {
  it('uses the measured size of the pane active in the worktree', () => {
    expect(resolveNewTerminalTabSize(snapshotWithActivePane('pty-active'), getSize)).toEqual({
      cols: 211,
      rows: 57
    })
  })

  it('falls back to 120x40 when the worktree has no measured pane', () => {
    expect(resolveNewTerminalTabSize(undefined, getSize)).toEqual({ cols: 120, rows: 40 })
    expect(resolveNewTerminalTabSize(snapshotWithActivePane(null), getSize)).toEqual({
      cols: 120,
      rows: 40
    })
    expect(resolveNewTerminalTabSize(snapshotWithActivePane('pty-unknown'), getSize)).toEqual({
      cols: 120,
      rows: 40
    })
  })
})
