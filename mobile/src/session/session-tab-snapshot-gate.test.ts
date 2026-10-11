import { describe, expect, it } from 'vitest'
import {
  SESSION_TAB_CLOSE_SETTLED_TTL_MS,
  SessionTabCloseLedger
} from '../../../src/shared/session-tab-close-ledger'
import type { MobileSessionTab } from './mobile-session-route-types'
import {
  acceptSessionSnapshot,
  confirmsMirroredTabSelection,
  hidePendingTabCloses,
  recordAcceptedTabClose,
  type AppliedSnapshotMarker
} from './session-tab-snapshot-gate'

describe('acceptSessionSnapshot', () => {
  it('accepts a newer version from the same publisher and advances the floor', () => {
    const marker: AppliedSnapshotMarker = { epoch: 'renderer:a', version: 5 }
    expect(
      acceptSessionSnapshot({ publicationEpoch: 'renderer:a', snapshotVersion: 6 }, marker)
    ).toBe(true)
    expect(marker).toEqual({ epoch: 'renderer:a', version: 6 })
  })

  it('rejects a strictly older version from the same publisher without moving the floor', () => {
    const marker: AppliedSnapshotMarker = { epoch: 'renderer:a', version: 42 }
    expect(
      acceptSessionSnapshot({ publicationEpoch: 'renderer:a', snapshotVersion: 41 }, marker)
    ).toBe(false)
    expect(marker).toEqual({ epoch: 'renderer:a', version: 42 })
  })

  it('accepts an equal version (reprocess) so pending tab closes can expire and clear', () => {
    const marker: AppliedSnapshotMarker = { epoch: 'renderer:a', version: 42 }
    // Polling returns the same cached version repeatedly; reprocessing is needed
    // so hidePendingTabCloses can run its TTL/clear pass.
    expect(
      acceptSessionSnapshot({ publicationEpoch: 'renderer:a', snapshotVersion: 42 }, marker)
    ).toBe(true)
    expect(marker).toEqual({ epoch: 'renderer:a', version: 42 })
  })

  it('accepts any version from a new publisher (epoch change) and resets the floor', () => {
    const marker: AppliedSnapshotMarker = { epoch: 'renderer:a', version: 99 }
    // Lower version but different epoch (renderer reload / headless) → accepted.
    expect(
      acceptSessionSnapshot({ publicationEpoch: 'headless:b', snapshotVersion: 1 }, marker)
    ).toBe(true)
    expect(marker).toEqual({ epoch: 'headless:b', version: 1 })
  })

  it('treats a missing epoch as its own publisher key', () => {
    const marker: AppliedSnapshotMarker = { epoch: null, version: -1 }
    expect(acceptSessionSnapshot({ snapshotVersion: 5 }, marker)).toBe(true)
    // A strictly older snapshot from the same (null) publisher is rejected.
    expect(acceptSessionSnapshot({ snapshotVersion: 4 }, marker)).toBe(false)
    expect(marker).toEqual({ epoch: null, version: 5 })
  })
})

describe('confirmsMirroredTabSelection', () => {
  it('does not treat phone-local persistence as desktop focus confirmation', () => {
    expect(confirmsMirroredTabSelection('mobile-local:abc')).toBe(false)
  })

  it('accepts renderer, headless, and legacy publications as confirmation', () => {
    expect(confirmsMirroredTabSelection('renderer:abc')).toBe(true)
    expect(confirmsMirroredTabSelection('headless:abc')).toBe(true)
    expect(confirmsMirroredTabSelection()).toBe(true)
  })
})

describe('hidePendingTabCloses', () => {
  const WT = 'wt-1'
  const NOW = 1_000_000
  const file = (id: string): MobileSessionTab => ({
    type: 'file',
    id,
    title: id,
    filePath: `/w/${id}`,
    relativePath: id,
    isDirty: false,
    isActive: false
  })
  const pane = (parent: string, leaf: string): MobileSessionTab => ({
    type: 'terminal',
    id: `${parent}::${leaf}`,
    parentTabId: parent,
    leafId: leaf,
    title: 'T',
    terminal: `term-${leaf}`,
    isActive: false
  })
  const ids = (tabs: readonly MobileSessionTab[]): string[] => tabs.map((tab) => tab.id)

  it('returns the tabs untouched when nothing is pending', () => {
    const tabs = [file('a'), file('b')]
    expect(hidePendingTabCloses(new SessionTabCloseLedger(), WT, tabs, NOW)).toBe(tabs)
  })

  it('keeps a closed tab hidden from every snapshot that still lists it', () => {
    const ledger = new SessionTabCloseLedger()
    recordAcceptedTabClose(ledger, WT, 'a', NOW)
    expect(ids(hidePendingTabCloses(ledger, WT, [file('a'), file('b')], NOW))).toEqual(['b'])
    expect(ids(hidePendingTabCloses(ledger, WT, [file('a'), file('b')], NOW + 1000))).toEqual(['b'])
    expect(ledger.hasPending(WT, NOW)).toBe(true)
  })

  it('ends the close at the first snapshot that omits the tab', () => {
    const ledger = new SessionTabCloseLedger()
    recordAcceptedTabClose(ledger, WT, 'a', NOW)
    expect(ids(hidePendingTabCloses(ledger, WT, [file('b')], NOW))).toEqual(['b'])
    expect(ledger.hasPending(WT, NOW)).toBe(false)
    // A later tab with the same id (reopened) is shown.
    expect(ids(hidePendingTabCloses(ledger, WT, [file('a'), file('b')], NOW))).toEqual(['a', 'b'])
  })

  it('stops hiding a tab no snapshot confirmed gone after the backstop', () => {
    const ledger = new SessionTabCloseLedger()
    recordAcceptedTabClose(ledger, WT, 'a', NOW)
    const late = NOW + SESSION_TAB_CLOSE_SETTLED_TTL_MS + 1
    expect(ids(hidePendingTabCloses(ledger, WT, [file('a'), file('b')], late))).toEqual(['a', 'b'])
    expect(ledger.hasPending(WT, late)).toBe(false)
  })

  it('hides only the closed pane of a split terminal', () => {
    const ledger = new SessionTabCloseLedger()
    recordAcceptedTabClose(ledger, WT, 'tab::left', NOW)
    const tabs = [pane('tab', 'left'), pane('tab', 'right'), file('b')]
    expect(ids(hidePendingTabCloses(ledger, WT, tabs, NOW))).toEqual(['tab::right', 'b'])
  })

  it('hides every pane of a terminal tab closed as a whole', () => {
    const ledger = new SessionTabCloseLedger()
    recordAcceptedTabClose(ledger, WT, 'tab', NOW)
    const tabs = [pane('tab', 'left'), pane('tab', 'right'), file('b')]
    expect(ids(hidePendingTabCloses(ledger, WT, tabs, NOW))).toEqual(['b'])
  })

  it('never hides a tab in another worktree', () => {
    const ledger = new SessionTabCloseLedger()
    recordAcceptedTabClose(ledger, 'wt-2', 'a', NOW)
    expect(ids(hidePendingTabCloses(ledger, WT, [file('a')], NOW))).toEqual(['a'])
  })
})
