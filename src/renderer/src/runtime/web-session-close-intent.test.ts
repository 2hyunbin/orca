import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginWebSessionTabClose,
  clearEndedPairingWebSessionCloseIntents,
  clearWebSessionCloseIntentsForWorktree,
  filterWebSessionTabCloses,
  isWebSessionTabClosePending,
  resetWebSessionCloseIntentForTests,
  settleWebSessionTabClose
} from './web-session-close-intent'

const revisions = vi.hoisted(() => new Map<string, number>())
vi.mock('./runtime-environment-revision', () => ({
  getRuntimeEnvironmentRevision: (environmentId: string) => revisions.get(environmentId)
}))

const WT = 'repo::/wt'
const OWNER = { environmentId: 'runtime-a', pairingRevision: 1 }
const topLevel = (tab: { id: string; parentTabId?: string }): string => tab.parentTabId ?? tab.id

afterEach(() => {
  resetWebSessionCloseIntentForTests()
  revisions.clear()
})

describe('web session tab close records', () => {
  it('hides the tab until the host has accepted and a host list omits it', () => {
    const ticket = beginWebSessionTabClose(OWNER, WT, 'host-tab-1', 1000)!
    const listed = [{ id: 'host-tab-1' }, { id: 'host-tab-2' }]
    expect(filterWebSessionTabCloses(OWNER, WT, listed, topLevel, 1000)).toEqual([
      { id: 'host-tab-2' }
    ])
    settleWebSessionTabClose(ticket, 'closed', 1001)
    filterWebSessionTabCloses(OWNER, WT, [{ id: 'host-tab-2' }], topLevel, 1002)
    expect(isWebSessionTabClosePending(OWNER, WT, 'host-tab-1', 1002)).toBe(false)
  })

  it('scopes records by owner, pairing revision, and worktree', () => {
    beginWebSessionTabClose(OWNER, WT, 'host-tab-1', 1000)
    expect(
      isWebSessionTabClosePending(
        { environmentId: 'runtime-b', pairingRevision: 1 },
        WT,
        'host-tab-1',
        1000
      )
    ).toBe(false)
    expect(
      isWebSessionTabClosePending(
        { environmentId: 'runtime-a', pairingRevision: 2 },
        WT,
        'host-tab-1',
        1000
      )
    ).toBe(false)
    expect(isWebSessionTabClosePending(OWNER, 'other::/wt', 'host-tab-1', 1000)).toBe(false)
  })

  it('clears one worktree without crossing partitions', () => {
    beginWebSessionTabClose(OWNER, WT, 'host-tab-2', 1000)
    beginWebSessionTabClose(OWNER, 'other-wt', 'host-tab-3', 1000)
    clearWebSessionCloseIntentsForWorktree(OWNER, WT)
    expect(isWebSessionTabClosePending(OWNER, WT, 'host-tab-2', 1000)).toBe(false)
    expect(isWebSessionTabClosePending(OWNER, 'other-wt', 'host-tab-3', 1000)).toBe(true)
  })

  it('drops only the closes of pairings that ended', () => {
    revisions.set('runtime-a', 1)
    revisions.set('runtime-b', 1)
    const otherOwner = { environmentId: 'runtime-b', pairingRevision: 1 }
    beginWebSessionTabClose(OWNER, WT, 'host-tab-1', 1000)
    beginWebSessionTabClose(otherOwner, WT, 'host-tab-2', 1000)
    revisions.set('runtime-b', 2)
    clearEndedPairingWebSessionCloseIntents()
    expect(isWebSessionTabClosePending(OWNER, WT, 'host-tab-1', 1000)).toBe(true)
    expect(isWebSessionTabClosePending(otherOwner, WT, 'host-tab-2', 1000)).toBe(false)
  })

  it('ignores empty ids', () => {
    expect(beginWebSessionTabClose(OWNER, WT, '   ', 1000)).toBeNull()
    expect(isWebSessionTabClosePending(OWNER, WT, '', 1000)).toBe(false)
  })
})
