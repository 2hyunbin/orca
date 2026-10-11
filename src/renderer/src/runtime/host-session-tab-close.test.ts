import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SESSION_TAB_CLOSE_SETTLED_TTL_MS,
  SESSION_TAB_CLOSE_UNSETTLED_BOUND_MS
} from '../../../shared/session-tab-close-ledger'
import { settleHostSessionTabClose } from './host-session-tab-close'
import {
  beginWebSessionCloseIntent,
  filterWebSessionCloseIntents,
  isWebSessionCloseIntentPending,
  resetWebSessionCloseIntentForTests
} from './web-session-close-intent'

const OWNER = { environmentId: 'env-1', pairingRevision: 1 }
const WT = 'repo::/wt'
const TAB = 'host-tab-1'

function rpcError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

function closeWith(
  close: Promise<{ refused?: boolean; snapshotRepublished?: boolean } | undefined>,
  absentTabMayReturn = false
) {
  const ticket = beginWebSessionCloseIntent(OWNER, WT, TAB, Date.now())!
  const reread = vi.fn(async (_acceptCurrent: boolean) => {})
  const result = settleHostSessionTabClose({
    tickets: () => [ticket],
    close,
    reread,
    readAfterClose: true,
    absentTabMayReturn
  })
  return { result, reread }
}

const pending = (): boolean => isWebSessionCloseIntentPending(OWNER, WT, TAB, Date.now())

afterEach(() => {
  resetWebSessionCloseIntentForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('settleHostSessionTabClose', () => {
  it('keeps an accepted close hiding the tab until a host list omits it', async () => {
    const { result, reread } = closeWith(Promise.resolve(undefined))
    await expect(result).resolves.toBe('applied')
    expect(pending()).toBe(true)
    // The read after an accepted close, for hosts whose lists travel apart from the answer.
    expect(reread).toHaveBeenCalledOnce()
    filterWebSessionCloseIntents(OWNER, WT, [], (tab: { id: string }) => tab.id, Date.now())
    expect(pending()).toBe(false)
  })

  it('brings the tab back at once when the close fails, for every tab kind', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result, reread } = closeWith(Promise.reject(rpcError('runtime_unavailable')))
    await expect(result).resolves.toBe('failed')
    expect(pending()).toBe(false)
    expect(reread).toHaveBeenCalledOnce()
  })

  it('keeps hiding a tab the host says it does not have, with no read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result, reread } = closeWith(Promise.reject(rpcError('terminal_tab_not_found')))
    await expect(result).resolves.toBe('unknown-tab')
    expect(isWebSessionCloseIntentPending(OWNER, WT, TAB, Date.now() + 10 * 60_000)).toBe(true)
    expect(reread).not.toHaveBeenCalled()
  })

  it('limits a "no such tab" answer in time when the host may list the tab again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result } = closeWith(Promise.reject(rpcError('tab_not_found')), true)
    await expect(result).resolves.toBe('unknown-tab')
    expect(pending()).toBe(true)
    expect(
      isWebSessionCloseIntentPending(
        OWNER,
        WT,
        TAB,
        Date.now() + SESSION_TAB_CLOSE_SETTLED_TTL_MS + 1
      )
    ).toBe(false)
  })

  it('shows a tab the host refused to close and republished, and still reports it heard', async () => {
    const { result, reread } = closeWith(
      Promise.resolve({ refused: true, snapshotRepublished: true })
    )
    await expect(result).resolves.toBe('applied')
    expect(pending()).toBe(false)
    expect(reread).toHaveBeenCalledOnce()
  })

  it('keeps hiding a refused close that republished nothing', async () => {
    const { result } = closeWith(Promise.resolve({ refused: true }))
    await expect(result).resolves.toBe('applied')
    expect(pending()).toBe(true)
  })

  it('fails a close nobody answers within the bound and ignores its late answer', async () => {
    vi.useFakeTimers()
    let answer!: () => void
    const { result, reread } = closeWith(
      new Promise((resolve) => {
        answer = () => resolve(undefined)
      })
    )
    await vi.advanceTimersByTimeAsync(SESSION_TAB_CLOSE_UNSETTLED_BOUND_MS)
    await expect(result).resolves.toBe('failed')
    expect(pending()).toBe(false)
    expect(reread).toHaveBeenCalledOnce()
    // A newer close of the same tab must not be settled by the old call's late answer.
    beginWebSessionCloseIntent(OWNER, WT, TAB, Date.now())
    answer()
    await vi.advanceTimersByTimeAsync(0)
    expect(pending()).toBe(true)
    expect(reread).toHaveBeenCalledOnce()
  })
})
