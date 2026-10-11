import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_TAB_CLOSE_UNSETTLED_BOUND_MS } from '../../../shared/session-tab-close-ledger'
import { settleHostSessionTabClose } from './host-session-tab-close'
import {
  beginWebSessionTabClose,
  filterWebSessionTabCloses,
  isWebSessionTabClosePending,
  resetWebSessionCloseIntentForTests
} from './web-session-close-intent'

const OWNER = { environmentId: 'env-1', pairingRevision: 1 }
const WT = 'repo::/wt'
const TAB = 'host-tab-1'

function rpcError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

function closeWith(
  close: Promise<{ refused?: boolean; snapshotRepublished?: boolean } | undefined>
) {
  const ticket = beginWebSessionTabClose(OWNER, WT, TAB, Date.now())!
  const rereadAcceptingCurrent = vi.fn()
  const readAfterClose = vi.fn()
  const result = settleHostSessionTabClose({
    tickets: () => [ticket],
    close,
    rereadAcceptingCurrent,
    readAfterClose
  })
  return { result, rereadAcceptingCurrent, readAfterClose }
}

const pending = (): boolean => isWebSessionTabClosePending(OWNER, WT, TAB, Date.now())

afterEach(() => {
  resetWebSessionCloseIntentForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('settleHostSessionTabClose', () => {
  it('keeps an accepted close hiding the tab until a host list omits it', async () => {
    const { result, rereadAcceptingCurrent, readAfterClose } = closeWith(Promise.resolve(undefined))
    await expect(result).resolves.toBe('applied')
    expect(pending()).toBe(true)
    expect(readAfterClose).toHaveBeenCalledOnce()
    expect(rereadAcceptingCurrent).not.toHaveBeenCalled()
    filterWebSessionTabCloses(OWNER, WT, [], (tab: { id: string }) => tab.id, Date.now())
    expect(pending()).toBe(false)
  })

  it('brings the tab back at once when the close fails, for every tab kind', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result, rereadAcceptingCurrent, readAfterClose } = closeWith(
      Promise.reject(rpcError('runtime_unavailable'))
    )
    await expect(result).resolves.toBe('failed')
    expect(pending()).toBe(false)
    expect(rereadAcceptingCurrent).toHaveBeenCalledOnce()
    expect(readAfterClose).not.toHaveBeenCalled()
  })

  it('keeps hiding a tab the host says it does not have, with no read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result, rereadAcceptingCurrent } = closeWith(
      Promise.reject(rpcError('terminal_tab_not_found'))
    )
    await expect(result).resolves.toBe('unknown-tab')
    expect(isWebSessionTabClosePending(OWNER, WT, TAB, Date.now() + 10 * 60_000)).toBe(true)
    expect(rereadAcceptingCurrent).not.toHaveBeenCalled()
  })

  it('shows a tab the host refused to close and republished, and still reports it heard', async () => {
    const { result, rereadAcceptingCurrent } = closeWith(
      Promise.resolve({ refused: true, snapshotRepublished: true })
    )
    await expect(result).resolves.toBe('applied')
    expect(pending()).toBe(false)
    expect(rereadAcceptingCurrent).toHaveBeenCalledOnce()
  })

  it('keeps hiding a refused close that republished nothing', async () => {
    const { result, rereadAcceptingCurrent } = closeWith(Promise.resolve({ refused: true }))
    await expect(result).resolves.toBe('applied')
    expect(pending()).toBe(true)
    expect(rereadAcceptingCurrent).not.toHaveBeenCalled()
  })

  it('fails a close nobody answers within the bound and ignores its late answer', async () => {
    vi.useFakeTimers()
    let answer!: () => void
    const { result, rereadAcceptingCurrent } = closeWith(
      new Promise((resolve) => {
        answer = () => resolve(undefined)
      })
    )
    await vi.advanceTimersByTimeAsync(SESSION_TAB_CLOSE_UNSETTLED_BOUND_MS)
    await expect(result).resolves.toBe('failed')
    expect(pending()).toBe(false)
    expect(rereadAcceptingCurrent).toHaveBeenCalledOnce()
    answer()
    await vi.advanceTimersByTimeAsync(0)
    expect(pending()).toBe(false)
  })
})
