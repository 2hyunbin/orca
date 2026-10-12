import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeEnvironmentRevision from './runtime-environment-revision'
import {
  beginWebSessionCloseIntent,
  clearEndedPairingWebSessionCloseIntents,
  clearWebSessionCloseIntentsForWorktree,
  filterWebSessionCloseIntents,
  isWebSessionCloseIntentPending,
  resetWebSessionCloseIntentForTests,
  settleWebSessionCloseIntent,
  registerWebSessionClosePlacementStateReader
} from './web-session-close-intent'

import {
  SESSION_TAB_CLOSE_UNSETTLED_BOUND_MS,
  SESSION_TAB_CLOSE_UNSETTLED_EXPIRY_MS
} from '../../../shared/session-tab-close-ledger'
import { WEB_SESSION_TAB_RPC_TIMEOUT_MS } from './web-session-tab-rpc-timeout'

const revisions = vi.hoisted(() => new Map<string, number>())
vi.mock('./runtime-environment-revision', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeEnvironmentRevision>()),
  getRuntimeEnvironmentRevision: (environmentId: string) => revisions.get(environmentId)
}))

const WT = 'repo::/wt'
const OWNER = { environmentId: 'runtime-a', pairingRevision: 1 }
const topLevel = (tab: { id: string; parentTabId?: string }): string => tab.parentTabId ?? tab.id

beforeEach(() =>
  registerWebSessionClosePlacementStateReader(() => ({
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    tabBarOrderByWorktree: {}
  }))
)

afterEach(() => {
  resetWebSessionCloseIntentForTests()
  revisions.clear()
  vi.restoreAllMocks()
})

describe('web session tab close records', () => {
  it('hides the tab until the host has accepted and a host list omits it', () => {
    const ticket = beginWebSessionCloseIntent(OWNER, WT, 'host-tab-1', 1000)!
    const listed = [{ id: 'host-tab-1' }, { id: 'host-tab-2' }]
    expect(filterWebSessionCloseIntents(OWNER, WT, listed, topLevel, 1000)).toEqual([
      { id: 'host-tab-2' }
    ])
    settleWebSessionCloseIntent(ticket, 'closed', 1001)
    filterWebSessionCloseIntents(OWNER, WT, [{ id: 'host-tab-2' }], topLevel, 1002)
    expect(isWebSessionCloseIntentPending(OWNER, WT, 'host-tab-1', 1002)).toBe(false)
  })

  it('scopes records by owner, pairing revision, and worktree', () => {
    beginWebSessionCloseIntent(OWNER, WT, 'host-tab-1', 1000)
    expect(
      isWebSessionCloseIntentPending(
        { environmentId: 'runtime-b', pairingRevision: 1 },
        WT,
        'host-tab-1',
        1000
      )
    ).toBe(false)
    expect(
      isWebSessionCloseIntentPending(
        { environmentId: 'runtime-a', pairingRevision: 2 },
        WT,
        'host-tab-1',
        1000
      )
    ).toBe(false)
    expect(isWebSessionCloseIntentPending(OWNER, 'other::/wt', 'host-tab-1', 1000)).toBe(false)
  })

  it('clears one worktree without crossing partitions', () => {
    beginWebSessionCloseIntent(OWNER, WT, 'host-tab-2', 1000)
    beginWebSessionCloseIntent(OWNER, 'other-wt', 'host-tab-3', 1000)
    clearWebSessionCloseIntentsForWorktree(OWNER, WT)
    expect(isWebSessionCloseIntentPending(OWNER, WT, 'host-tab-2', 1000)).toBe(false)
    expect(isWebSessionCloseIntentPending(OWNER, 'other-wt', 'host-tab-3', 1000)).toBe(true)
  })

  it('drops only the closes of pairings that ended', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    revisions.set('runtime-a', 1)
    revisions.set('runtime-b', 1)
    const otherOwner = { environmentId: 'runtime-b', pairingRevision: 1 }
    beginWebSessionCloseIntent(OWNER, WT, 'host-tab-1', 1000)
    beginWebSessionCloseIntent(otherOwner, WT, 'host-tab-2', 1000)
    revisions.set('runtime-b', 2)
    clearEndedPairingWebSessionCloseIntents()
    expect(isWebSessionCloseIntentPending(OWNER, WT, 'host-tab-1', 1000)).toBe(true)
    expect(isWebSessionCloseIntentPending(otherOwner, WT, 'host-tab-2', 1000)).toBe(false)
  })

  // A "no such tab" answer can arrive up to the call's own timeout; the record must still be there
  // to keep the tab hidden (#9194), so its limits are tied to that timeout, not separate literals.
  it('outlives the tab RPC that can still answer', () => {
    expect(SESSION_TAB_CLOSE_UNSETTLED_BOUND_MS).toBe(WEB_SESSION_TAB_RPC_TIMEOUT_MS)
    expect(SESSION_TAB_CLOSE_UNSETTLED_EXPIRY_MS).toBeGreaterThan(WEB_SESSION_TAB_RPC_TIMEOUT_MS)
  })

  it('ignores empty ids', () => {
    expect(beginWebSessionCloseIntent(OWNER, WT, '   ', 1000)).toBeNull()
    expect(isWebSessionCloseIntentPending(OWNER, WT, '', 1000)).toBe(false)
  })
})
