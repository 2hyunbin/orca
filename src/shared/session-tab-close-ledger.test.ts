import { describe, expect, it } from 'vitest'
import {
  SESSION_TAB_CLOSE_SETTLED_TTL_MS,
  SESSION_TAB_CLOSE_UNSETTLED_BOUND_MS,
  SESSION_TAB_CLOSE_UNSETTLED_EXPIRY_MS,
  SessionTabCloseLedger
} from './session-tab-close-ledger'

type Tab = { id: string; parentTabId?: string }

const P = 'host-a\0wt-1'
const NOW = 1_800_000_000_000
const topLevel = (tab: Tab): string => tab.parentTabId ?? tab.id
const ids = (tabs: readonly Tab[]): string[] => tabs.map((tab) => tab.id)

function apply(ledger: SessionTabCloseLedger, tabs: Tab[], now = NOW): string[] {
  return ids(ledger.filter(P, tabs, topLevel, now))
}

describe('SessionTabCloseLedger', () => {
  it('hides a tab while its close is unanswered, even across lists that omit it', () => {
    const ledger = new SessionTabCloseLedger()
    ledger.begin(P, 'b', NOW)
    expect(apply(ledger, [{ id: 'a' }, { id: 'b' }])).toEqual(['a'])
    expect(apply(ledger, [{ id: 'a' }])).toEqual(['a'])
    // A stale list naming it again must not bring it back before the host answers.
    expect(apply(ledger, [{ id: 'a' }, { id: 'b' }])).toEqual(['a'])
  })

  it('ends a closed entry at the first list without the tab', () => {
    const ledger = new SessionTabCloseLedger()
    const ticket = ledger.begin(P, 'b', NOW)!
    expect(ledger.settle(ticket, 'closed', NOW)).toBe(true)
    expect(apply(ledger, [{ id: 'a' }, { id: 'b' }])).toEqual(['a'])
    expect(apply(ledger, [{ id: 'a' }])).toEqual(['a'])
    expect(ledger.hasPending(P)).toBe(false)
    expect(apply(ledger, [{ id: 'a' }, { id: 'b' }])).toEqual(['a', 'b'])
  })

  it('ends at once when the removal list was applied before the answer', () => {
    const ledger = new SessionTabCloseLedger()
    const ticket = ledger.begin(P, 'b', NOW)!
    apply(ledger, [{ id: 'a' }])
    ledger.settle(ticket, 'closed', NOW)
    expect(ledger.hasPending(P)).toBe(false)
  })

  it('lets the tab back when the close fails', () => {
    const ledger = new SessionTabCloseLedger()
    const ticket = ledger.begin(P, 'b', NOW)!
    ledger.settle(ticket, 'failed', NOW)
    expect(apply(ledger, [{ id: 'a' }, { id: 'b' }])).toEqual(['a', 'b'])
  })

  it('keeps an absent tab hidden with no time limit until a list omits it', () => {
    const ledger = new SessionTabCloseLedger()
    const ticket = ledger.begin(P, 'b', NOW)!
    ledger.settle(ticket, 'absent', NOW)
    const later = NOW + 10 * SESSION_TAB_CLOSE_SETTLED_TTL_MS
    expect(apply(ledger, [{ id: 'a' }, { id: 'b' }], later)).toEqual(['a'])
    expect(apply(ledger, [{ id: 'a' }], later)).toEqual(['a'])
    expect(apply(ledger, [{ id: 'b' }], later)).toEqual(['b'])
  })

  it("honours an answer that arrives by the caller's own limit", () => {
    const ledger = new SessionTabCloseLedger()
    const ticket = ledger.begin(P, 'b', NOW)!
    expect(SESSION_TAB_CLOSE_UNSETTLED_EXPIRY_MS).toBeGreaterThan(
      SESSION_TAB_CLOSE_UNSETTLED_BOUND_MS
    )
    expect(ledger.settle(ticket, 'absent', NOW + SESSION_TAB_CLOSE_UNSETTLED_BOUND_MS)).toBe(true)
    expect(apply(ledger, [{ id: 'b' }], NOW + 60_000)).toEqual([])
  })

  it('ends an absent entry at once when the host list already omitted the tab', () => {
    const ledger = new SessionTabCloseLedger()
    const ticket = ledger.begin(P, 'b', NOW)!
    apply(ledger, [{ id: 'a' }])
    ledger.settle(ticket, 'absent', NOW)
    expect(ledger.hasPending(P)).toBe(false)
  })

  it('drops an unanswered close after its expiry and ignores its late answer', () => {
    const ledger = new SessionTabCloseLedger()
    const ticket = ledger.begin(P, 'b', NOW)!
    const late = NOW + SESSION_TAB_CLOSE_UNSETTLED_EXPIRY_MS + 1
    expect(apply(ledger, [{ id: 'b' }], late)).toEqual(['b'])
    expect(ledger.settle(ticket, 'closed', late)).toBe(false)
    expect(apply(ledger, [{ id: 'b' }], late)).toEqual(['b'])
  })

  it('bounds a closed entry no list ever confirms', () => {
    const ledger = new SessionTabCloseLedger()
    const ticket = ledger.begin(P, 'b', NOW)!
    ledger.settle(ticket, 'closed', NOW)
    expect(apply(ledger, [{ id: 'b' }], NOW + SESSION_TAB_CLOSE_SETTLED_TTL_MS + 1)).toEqual(['b'])
  })

  it('hides every pane of a closed tab, and only the pane a pane close names', () => {
    const ledger = new SessionTabCloseLedger()
    const panes: Tab[] = [
      { id: 't1::l1', parentTabId: 't1' },
      { id: 't1::l2', parentTabId: 't1' },
      { id: 't2::l1', parentTabId: 't2' }
    ]
    ledger.begin(P, 't1::l2', NOW)
    expect(apply(ledger, panes)).toEqual(['t1::l1', 't2::l1'])
    ledger.begin(P, 't2', NOW)
    expect(apply(ledger, panes)).toEqual(['t1::l1'])
  })

  it('a newer close of the same id supersedes the older answer', () => {
    const ledger = new SessionTabCloseLedger()
    const first = ledger.begin(P, 'b', NOW)!
    ledger.begin(P, 'b', NOW + 1)
    expect(ledger.settle(first, 'failed', NOW + 2)).toBe(false)
    expect(apply(ledger, [{ id: 'b' }], NOW + 2)).toEqual([])
  })

  it('scopes entries to their partition and evicts the oldest partition past the cap', () => {
    const ledger = new SessionTabCloseLedger({ maxPartitions: 2 })
    ledger.begin('p1', 'b', NOW)
    ledger.begin('p2', 'b', NOW)
    expect(ids(ledger.filter('p3', [{ id: 'b' }], topLevel, NOW))).toEqual(['b'])
    ledger.begin('p3', 'b', NOW)
    expect(ledger.hasPending('p1')).toBe(false)
    expect(ledger.hasPending('p2')).toBe(true)
    ledger.clearPartition('p2')
    expect(ledger.hasPending('p2')).toBe(false)
  })

  it('returns the same array when nothing is hidden', () => {
    const ledger = new SessionTabCloseLedger()
    const tabs: Tab[] = [{ id: 'a' }]
    expect(ledger.filter(P, tabs, topLevel, NOW)).toBe(tabs)
    ledger.begin(P, 'z', NOW)
    expect(ledger.filter(P, tabs, topLevel, NOW)).toBe(tabs)
  })
})
