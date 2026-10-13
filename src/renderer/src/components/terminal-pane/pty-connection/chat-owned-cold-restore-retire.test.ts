import { describe, expect, it, vi } from 'vitest'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { bindDeferredColdRestoreAndSnapshot } from './deferred-cold-restore-and-snapshot'

const store = vi.hoisted(() => ({
  dropAgentStatus: vi.fn(),
  clearPaneForegroundAgent: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))

describe('retireChatOwnedColdRestore', () => {
  it('drops the status row with no resumable remnant, the agent hint, and the saved record', () => {
    const saved = { paneKey: 'tab-1:leaf-1', record: { agent: 'pi' } }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a deliberately partial session bag; retire reads only these members.
    const session = {
      cacheKey: 'tab-1:leaf-1',
      getSleepingRecordForPane: vi.fn(() => saved),
      clearSleepingRecordProviderDuplicates: vi.fn()
    } as unknown as ConnectPanePtySession
    bindDeferredColdRestoreAndSnapshot(session)

    expect(session.retireChatOwnedColdRestore(null)).toBeNull()

    expect(store.dropAgentStatus).toHaveBeenCalledWith('tab-1:leaf-1', { forgetResume: true })
    expect(store.clearPaneForegroundAgent).toHaveBeenCalledWith('tab-1:leaf-1')
    expect(session.clearSleepingRecordProviderDuplicates).toHaveBeenCalledWith(store, saved)
  })
})
