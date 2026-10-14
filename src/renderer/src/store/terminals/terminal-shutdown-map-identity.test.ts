import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { commitTerminalShutdownState } from './terminal-shutdown-state'

const WORKTREE = 'repo::/tmp/app'
const TAB_ID = 'tab-a'

const tab = { id: TAB_ID, worktreeId: WORKTREE } as unknown as TerminalTab

/** Maps a shutdown with nothing left to clear must not re-reference. */
const UNTOUCHED_FIELDS = [
  'ptyIdsByTabId',
  'suppressedPtyExitIds',
  'pendingPtyShutdownIds',
  'pendingCodexPaneRestartIds',
  'codexRestartNoticeByPtyId',
  'pendingSetupSplitByTabId',
  'pendingIssueCommandSplitByTabId',
  'terminalLayoutsByTabId',
  'runtimePaneTitlesByTabId',
  'lastKnownRelayPtyIdByTabId'
] as const

function buildState(overrides: Partial<AppState> = {}): AppState {
  return {
    tabsByWorktree: { [WORKTREE]: [tab] },
    // The tab already exited: its pty list is present and empty.
    ptyIdsByTabId: { [TAB_ID]: [] },
    suppressedPtyExitIds: {},
    pendingPtyShutdownIds: {},
    pendingCodexPaneRestartIds: {},
    codexRestartNoticeByPtyId: {},
    pendingSetupSplitByTabId: {},
    pendingIssueCommandSplitByTabId: {},
    terminalLayoutsByTabId: {},
    runtimePaneTitlesByTabId: {},
    lastKnownRelayPtyIdByTabId: {},
    unreadTerminalTabs: {},
    unreadTerminalPanes: {},
    unreadAgentCompletionPanes: {},
    lastTerminalInputAtByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    // Post-write actions this helper calls; irrelevant to the identity contract.
    dropAgentStatusByWorktree: () => undefined,
    clearPaneForegroundAgentByWorktree: () => undefined,
    clearSleepingAgentSessionsByWorktree: () => undefined,
    isPtyShutdownPending: () => false,
    ...overrides
  } as unknown as AppState
}

function commit(state: AppState, exitGuardPtyIds: readonly string[] = []): AppState {
  let current = state
  commitTerminalShutdownState({
    exitGuardPtyIds,
    get: (() => current) as never,
    keepIdentifiers: true,
    retainedCompletionEvidence: [],
    set: ((update: unknown) => {
      const patch =
        typeof update === 'function' ? (update as (s: AppState) => object)(current) : update
      current = { ...current, ...(patch as object) }
    }) as never,
    shutdownReason: 'manual-sleep',
    sleepingAgentSessionRecords: {},
    tabs: state.tabsByWorktree[WORKTREE] ?? [],
    worktreeId: WORKTREE
  })
  return current
}

describe('terminal shutdown map identity', () => {
  it.each([0, 1, 20])('enumerates each global pane record at most once for %i tabs', (tabCount) => {
    const tabs = Array.from({ length: tabCount }, (_, index) => ({ ...tab, id: `tab-${index}` }))
    const before = buildState({
      tabsByWorktree: { [WORKTREE]: tabs },
      ptyIdsByTabId: Object.fromEntries(tabs.map((entry) => [entry.id, []])),
      unreadTerminalPanes: { 'other-tab:1': true },
      unreadAgentCompletionPanes: { 'other-tab:1': true },
      lastTerminalInputAtByPaneKey: { 'other-tab:1': 123 }
    })
    const records: object[] = [
      before.unreadTerminalPanes,
      before.unreadAgentCompletionPanes,
      before.lastTerminalInputAtByPaneKey
    ]
    const counts = new Map<object, number>()
    const originalKeys = Object.keys
    const keys = vi.spyOn(Object, 'keys').mockImplementation((record: object) => {
      if (records.includes(record)) {
        counts.set(record, (counts.get(record) ?? 0) + 1)
      }
      return originalKeys(record)
    })
    try {
      const after = commit(before)
      for (const record of records) {
        expect(counts.get(record) ?? 0).toBe(tabCount === 0 ? 0 : 1)
      }
      expect(after.unreadTerminalPanes).toBe(before.unreadTerminalPanes)
      expect(after.unreadAgentCompletionPanes).toBe(before.unreadAgentCompletionPanes)
      expect(after.lastTerminalInputAtByPaneKey).toBe(before.lastTerminalInputAtByPaneKey)
    } finally {
      keys.mockRestore()
    }
  })

  it('clears only matching tab prefixes without mutating the original pane records', () => {
    const before = buildState({
      unreadTerminalPanes: {
        [`${TAB_ID}:1`]: true,
        [`${TAB_ID}:`]: true,
        [`${TAB_ID}:legacy:leaf`]: true,
        [`${TAB_ID}-other:1`]: true,
        [TAB_ID]: true
      },
      unreadAgentCompletionPanes: { [`${TAB_ID}:1`]: true, 'other-tab:1': true },
      lastTerminalInputAtByPaneKey: { [`${TAB_ID}:1`]: 100, 'other-tab:1': 200 }
    })

    const after = commit(before)

    expect(after.unreadTerminalPanes).toEqual({ [`${TAB_ID}-other:1`]: true, [TAB_ID]: true })
    expect(after.unreadAgentCompletionPanes).toEqual({ 'other-tab:1': true })
    expect(after.lastTerminalInputAtByPaneKey).toEqual({ 'other-tab:1': 200 })
    expect(before.unreadTerminalPanes[`${TAB_ID}:1`]).toBe(true)
    expect(before.unreadAgentCompletionPanes[`${TAB_ID}:1`]).toBe(true)
    expect(before.lastTerminalInputAtByPaneKey[`${TAB_ID}:1`]).toBe(100)
  })

  it('keeps every map reference when the panes already exited', () => {
    const before = buildState()

    const after = commit(before)

    for (const field of UNTOUCHED_FIELDS) {
      expect(after[field], field).toBe(before[field])
    }
  })

  it('creates an absent pty-id entry rather than skipping it', () => {
    // An absent key is not an empty array: the spread this replaces created the key.
    const before = buildState({ ptyIdsByTabId: {} } as Partial<AppState>)

    const after = commit(before)

    expect(after.ptyIdsByTabId).not.toBe(before.ptyIdsByTabId)
    expect(TAB_ID in after.ptyIdsByTabId).toBe(true)
    expect(after.ptyIdsByTabId[TAB_ID]).toEqual([])
  })

  it('still clears a live pty list and drops the exit-guard bookkeeping', () => {
    const before = buildState({
      ptyIdsByTabId: { [TAB_ID]: ['pty-1'] },
      pendingPtyShutdownIds: { 'pty-1': 1 },
      codexRestartNoticeByPtyId: { 'pty-1': { reason: 'x' } }
    } as unknown as Partial<AppState>)

    const after = commit(before, ['pty-1'])

    expect(after.ptyIdsByTabId[TAB_ID]).toEqual([])
    expect(after.suppressedPtyExitIds['pty-1']).toBe(true)
    expect('pty-1' in after.pendingPtyShutdownIds).toBe(false)
    expect('pty-1' in after.codexRestartNoticeByPtyId).toBe(false)
  })
})
