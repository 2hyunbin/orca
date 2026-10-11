import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { RuntimeClientTarget } from './runtime-client-target'
import type * as StructuredAgentSessionClientModule from './structured-agent-session-client'

const mocks = vi.hoisted(() => ({
  closeSession:
    vi.fn<(target: RuntimeClientTarget, sessionId: string) => Promise<'closed' | 'unsupported'>>(),
  closesById: vi.fn<(target: RuntimeClientTarget) => Promise<boolean>>(),
  callRuntime:
    vi.fn<
      (
        target: RuntimeClientTarget,
        method: string,
        params?: unknown,
        options?: { timeoutMs?: number }
      ) => Promise<unknown>
    >(),
  ensureCompatible: vi.fn<(environmentId: string) => Promise<void>>(),
  discardOutbox: vi.fn<(sessionId: string) => void>(),
  stopSends: vi.fn<(sessionId: string) => void>(),
  hasTombstone: vi.fn<(worktreeId: string, sessionId: string) => boolean>(),
  markCancelled:
    vi.fn<(worktreeId: string, sessionId: string, executionHostId: string) => boolean>(),
  reacceptLocal:
    vi.fn<(worktreeId: string, options?: { reacceptCurrentVersion?: boolean }) => Promise<void>>(),
  refreshPaired:
    vi.fn<
      (
        environmentId: string,
        worktreeId: string,
        options?: { acceptCurrentSnapshot?: boolean; afterCurrentInFlight?: boolean }
      ) => Promise<void>
    >()
}))

vi.mock('@/lib/structured-agent-session-launch-registry', () => ({
  hasStructuredAgentSessionLaunchCancellationTombstone: mocks.hasTombstone,
  markStructuredAgentSessionLaunchCancelled: mocks.markCancelled
}))
vi.mock('@/lib/structured-agent-session-launch-prompt', () => ({
  discardStructuredAgentSessionChatSends: mocks.discardOutbox
}))
vi.mock('@/components/native-chat/structured-agent-session-message-sender', () => ({
  stopStructuredAgentSessionSends: mocks.stopSends
}))
vi.mock('./structured-agent-session-close', () => ({
  closeStructuredAgentSession: mocks.closeSession
}))
vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntime,
  ensureRuntimeEnvironmentCompatible: mocks.ensureCompatible
}))
vi.mock('./structured-agent-session-client', async (importOriginal) => ({
  ...(await importOriginal<typeof StructuredAgentSessionClientModule>()),
  supportsSessionTabsCloseAgentSessionById: mocks.closesById
}))
vi.mock('./local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionWorktreeTabs: mocks.reacceptLocal
}))
vi.mock('./web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: mocks.refreshPaired
}))
vi.mock('./runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: (worktreeId: string) => `id:${worktreeId}`
}))

import {
  beginStructuredAgentSessionTabClose,
  retireStructuredAgentSessionTab,
  suppressCancelledStructuredSessionTabs
} from './structured-agent-session-tab-retirement'
import {
  getStructuredAgentSessionReadOwner,
  findStructuredAgentSessionReadOwner,
  resetStructuredAgentSessionReadOwnersForTests
} from '@/components/native-chat/structured-agent-session-read-owner'
import {
  isWebSessionCloseIntentPending,
  filterWebSessionCloseIntents,
  resetWebSessionCloseIntentForTests
} from './web-session-close-intent'
import { LOCAL_STRUCTURED_SESSION_OWNER } from './local-structured-session-owner'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'

const target: RuntimeClientTarget = { kind: 'local' }

function snapshot(): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'wt-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: 'agent-session:session-1',
    activeTabType: 'agent-session',
    tabs: [
      {
        type: 'agent-session',
        id: 'agent-session:session-1',
        title: 'Codex Chat',
        sessionId: 'session-1',
        agent: 'codex',
        isActive: true
      }
    ],
    tabGroups: [
      {
        id: 'group-1',
        tabOrder: ['agent-session:session-1'],
        activeTabId: 'agent-session:session-1'
      }
    ]
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetStructuredAgentSessionReadOwnersForTests()
  resetWebSessionCloseIntentForTests()
  replaceRuntimeEnvironmentRevisions([])
  mocks.closeSession.mockResolvedValue('closed')
  mocks.closesById.mockResolvedValue(false)
  mocks.callRuntime.mockResolvedValue(undefined)
  mocks.ensureCompatible.mockResolvedValue(undefined)
  mocks.hasTombstone.mockReturnValue(false)
  mocks.reacceptLocal.mockResolvedValue(undefined)
  mocks.refreshPaired.mockResolvedValue(undefined)
})

// A host frame for wt-1 listing exactly these host tab ids, as the window applies it.
const applyHostFrame = (owner: { environmentId: string }, hostTabIds: readonly string[]): void => {
  filterWebSessionCloseIntents(
    owner,
    'wt-1',
    hostTabIds.map((id) => ({ id })),
    (tab) => tab.id,
    Date.now()
  )
}

const closing = (owner: string): boolean =>
  isWebSessionCloseIntentPending(
    { environmentId: owner },
    'wt-1',
    'agent-session:session-1',
    Date.now()
  )

describe('structured agent session tab retirement', () => {
  it('marks cancellation and clears local launch state before host cleanup', async () => {
    beginStructuredAgentSessionTabClose({
      target,
      worktreeId: 'wt-1',
      sessionId: 'session-1',
      provisional: true
    })
    expect(mocks.markCancelled).toHaveBeenCalledWith('wt-1', 'session-1', 'local')
    expect(mocks.discardOutbox).toHaveBeenCalledWith('session-1')
    expect(mocks.stopSends).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(mocks.callRuntime).toHaveBeenCalled())
    expect(mocks.closeSession).toHaveBeenCalledWith(target, 'session-1')
  })

  // Withdrawn, as a Stop does: nothing more goes out, and nothing is dropped.
  it("never drops a published chat's sends when its tab closes", async () => {
    beginStructuredAgentSessionTabClose({
      target,
      worktreeId: 'wt-1',
      sessionId: 'session-1',
      provisional: false
    })
    expect(mocks.discardOutbox).not.toHaveBeenCalled()
    expect(mocks.stopSends).toHaveBeenCalledWith('session-1')
    await vi.waitFor(() => expect(mocks.closeSession).toHaveBeenCalledWith(target, 'session-1'))
  })

  it('suppresses and retires a late cancelled publication', async () => {
    mocks.hasTombstone.mockReturnValue(true)
    const result = suppressCancelledStructuredSessionTabs(snapshot(), target)
    expect(result.tabs).toEqual([])
    expect(result.tabGroups).toEqual([])
    expect(result.activeTabId).toBeNull()
    await vi.waitFor(() => expect(mocks.closeSession).toHaveBeenCalledWith(target, 'session-1'))
    expect(mocks.callRuntime).toHaveBeenCalledWith(
      target,
      'session.tabs.close',
      expect.objectContaining({ tabId: 'agent-session:session-1' }),
      expect.objectContaining({ timeoutMs: 15_000 })
    )
  })

  it('hides a closing chat from host frames until one stops listing it', async () => {
    let answerClose!: () => void
    mocks.callRuntime.mockImplementation(
      () =>
        new Promise((resolve) => {
          answerClose = () => resolve(undefined)
        })
    )
    beginStructuredAgentSessionTabClose({
      target,
      worktreeId: 'wt-1',
      sessionId: 'session-1',
      provisional: false
    })
    expect(closing(LOCAL_STRUCTURED_SESSION_OWNER)).toBe(true)
    // A frame the host sent before handling the close still lists the chat.
    applyHostFrame({ environmentId: LOCAL_STRUCTURED_SESSION_OWNER }, ['agent-session:session-1'])
    expect(closing(LOCAL_STRUCTURED_SESSION_OWNER)).toBe(true)
    expect(mocks.reacceptLocal).not.toHaveBeenCalled()

    await vi.waitFor(() => expect(mocks.callRuntime).toHaveBeenCalled())
    answerClose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // This machine's host emitted its removal before answering, so that frame ends it: no read.
    expect(closing(LOCAL_STRUCTURED_SESSION_OWNER)).toBe(true)
    expect(mocks.reacceptLocal).not.toHaveBeenCalled()
    applyHostFrame({ environmentId: LOCAL_STRUCTURED_SESSION_OWNER }, [])
    expect(closing(LOCAL_STRUCTURED_SESSION_OWNER)).toBe(false)
  })

  it('records no intent for a floating-panel chat, whose frames are never applied', async () => {
    mocks.callRuntime.mockRejectedValue(new Error('window relay failed'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    beginStructuredAgentSessionTabClose({
      target,
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      sessionId: 'session-1',
      provisional: false
    })
    expect(
      isWebSessionCloseIntentPending(
        { environmentId: LOCAL_STRUCTURED_SESSION_OWNER },
        FLOATING_TERMINAL_WORKTREE_ID,
        'agent-session:session-1',
        Date.now()
      )
    ).toBe(false)
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.reacceptLocal).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('shows a chat the local host kept by re-reading its worktree', async () => {
    mocks.callRuntime.mockRejectedValue(new Error('window relay failed'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    beginStructuredAgentSessionTabClose({
      target,
      worktreeId: 'wt-1',
      sessionId: 'session-1',
      provisional: false
    })
    await vi.waitFor(() =>
      expect(mocks.reacceptLocal).toHaveBeenCalledWith('wt-1', { reacceptCurrentVersion: true })
    )
    expect(closing(LOCAL_STRUCTURED_SESSION_OWNER)).toBe(false)
    expect(mocks.refreshPaired).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('shows a chat a paired host kept by re-reading its worktree', async () => {
    const paired = { kind: 'environment', environmentId: 'server-1' } as const
    let failClose!: () => void
    mocks.callRuntime.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failClose = () => reject(new Error('runtime_unavailable'))
        })
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    beginStructuredAgentSessionTabClose({
      target: paired,
      worktreeId: 'wt-1',
      sessionId: 'session-1',
      provisional: false
    })
    expect(closing('server-1')).toBe(true)
    expect(closing(LOCAL_STRUCTURED_SESSION_OWNER)).toBe(false)

    await vi.waitFor(() => expect(mocks.callRuntime).toHaveBeenCalled())
    failClose()
    await vi.waitFor(() =>
      expect(mocks.refreshPaired).toHaveBeenCalledWith('server-1', 'wt-1', {
        acceptCurrentSnapshot: true,
        afterCurrentInFlight: true
      })
    )
    expect(closing('server-1')).toBe(false)
    expect(mocks.reacceptLocal).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('re-reads a paired server after a successful close, since its frames travel apart from its answer', async () => {
    const paired = { kind: 'environment', environmentId: 'server-1' } as const
    beginStructuredAgentSessionTabClose({
      target: paired,
      worktreeId: 'wt-1',
      sessionId: 'session-1',
      provisional: false
    })
    await vi.waitFor(() =>
      expect(mocks.refreshPaired).toHaveBeenCalledWith('server-1', 'wt-1', {
        // The host's removal is a newer version; only an older read in flight must be waited out.
        acceptCurrentSnapshot: false,
        afterCurrentInFlight: true
      })
    )
    // Only a frame without the chat ends the hide.
    expect(closing('server-1')).toBe(true)
    expect(mocks.reacceptLocal).not.toHaveBeenCalled()
  })

  it('clears a paired close intent under the pairing it began with', async () => {
    const paired = { kind: 'environment', environmentId: 'server-1' } as const
    replaceRuntimeEnvironmentRevisions([{ id: 'server-1', createdAt: 0, pairingRevision: 3 }])
    let failClose!: () => void
    mocks.callRuntime.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failClose = () => reject(new Error('runtime_unavailable'))
        })
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    beginStructuredAgentSessionTabClose({
      target: paired,
      worktreeId: 'wt-1',
      sessionId: 'session-1',
      provisional: false
    })
    const pendingUnder = (pairingRevision: number): boolean =>
      isWebSessionCloseIntentPending(
        { environmentId: 'server-1', pairingRevision },
        'wt-1',
        'agent-session:session-1',
        Date.now()
      )
    expect(pendingUnder(3)).toBe(true)

    // Re-paired while the close is in flight.
    replaceRuntimeEnvironmentRevisions([{ id: 'server-1', createdAt: 0, pairingRevision: 4 }])
    await vi.waitFor(() => expect(mocks.callRuntime).toHaveBeenCalled())
    failClose()
    await vi.waitFor(() =>
      expect(mocks.refreshPaired).toHaveBeenCalledWith('server-1', 'wt-1', {
        acceptCurrentSnapshot: true,
        afterCurrentInFlight: true,
        expectedEnvironmentPairingRevision: 3
      })
    )
    expect(pendingUnder(3)).toBe(false)
    warn.mockRestore()
  })

  it.each([
    ['this machine', { kind: 'local' } as const],
    ['a paired server', { kind: 'environment', environmentId: 'server-1' } as const]
  ])(
    'sends only the tab close to %s when it closes chats by id, a starting one included',
    async (_label, host) => {
      mocks.closesById.mockResolvedValue(true)
      beginStructuredAgentSessionTabClose({
        target: host,
        worktreeId: 'wt-1',
        sessionId: 'session-1',
        provisional: true
      })
      await vi.waitFor(() =>
        expect(mocks.callRuntime).toHaveBeenCalledWith(
          host,
          'session.tabs.close',
          { worktree: 'id:wt-1', tabId: 'agent-session:session-1', reason: 'user' },
          expect.objectContaining({ timeoutMs: 15_000 })
        )
      )
      expect(mocks.closesById).toHaveBeenCalledWith(host)
      expect(mocks.closeSession).not.toHaveBeenCalled()
      expect(mocks.callRuntime).toHaveBeenCalledTimes(1)
    }
  )

  it('sends both closes to a host that does not close chats by id', async () => {
    const paired = { kind: 'environment', environmentId: 'server-1' } as const
    beginStructuredAgentSessionTabClose({
      target: paired,
      worktreeId: 'wt-1',
      sessionId: 'session-1',
      provisional: false
    })
    await vi.waitFor(() => expect(mocks.callRuntime).toHaveBeenCalledTimes(1))
    expect(mocks.closesById).toHaveBeenCalledWith(paired)
    expect(mocks.closeSession).toHaveBeenCalledWith(paired, 'session-1')
    expect(mocks.callRuntime).toHaveBeenCalledWith(
      paired,
      'session.tabs.close',
      expect.objectContaining({ tabId: 'agent-session:session-1' }),
      expect.anything()
    )
  })

  it('sends neither close once a capability check outlasts the bound', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let answer!: (closesById: boolean) => void
    mocks.closesById.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    const settled = retireStructuredAgentSessionTab({
      target,
      worktreeId: 'wt-1',
      sessionId: 'session-1'
    })
    await vi.advanceTimersByTimeAsync(15_000)
    answer(false)
    expect((await settled).status).toBe('rejected')
    expect(mocks.closeSession).not.toHaveBeenCalled()
    expect(mocks.callRuntime).not.toHaveBeenCalled()
    vi.useRealTimers()
    warn.mockRestore()
  })

  it('deduplicates concurrent host retirement while the host tab close is in flight', async () => {
    let release!: () => void
    mocks.callRuntime.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(undefined)
        })
    )
    const first = retireStructuredAgentSessionTab({
      target,
      worktreeId: 'wt-1',
      sessionId: 'session-1'
    })
    await vi.waitFor(() => expect(mocks.callRuntime).toHaveBeenCalledTimes(1))
    expect(
      retireStructuredAgentSessionTab({ target, worktreeId: 'wt-1', sessionId: 'session-1' })
    ).toBe(first)
    expect(mocks.closeSession).toHaveBeenCalledTimes(1)
    release()
    await first
  })

  it('gives up on a hung local close after the bound: shows the chat, allows a retry', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.callRuntime.mockImplementation(() => new Promise(() => {}))
    beginStructuredAgentSessionTabClose({
      target,
      worktreeId: 'wt-1',
      sessionId: 'session-1',
      provisional: false
    })
    expect(closing(LOCAL_STRUCTURED_SESSION_OWNER)).toBe(true)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(closing(LOCAL_STRUCTURED_SESSION_OWNER)).toBe(false)
    expect(mocks.reacceptLocal).toHaveBeenCalledWith('wt-1', { reacceptCurrentVersion: true })
    retireStructuredAgentSessionTab({ target, worktreeId: 'wt-1', sessionId: 'session-1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.callRuntime).toHaveBeenCalledTimes(2)
    // Release the retry's in-flight slot so later tests start clean.
    await vi.advanceTimersByTimeAsync(15_000)
    vi.useRealTimers()
    warn.mockRestore()
  })

  it('never sends a paired close the window gave up on during a slow compatibility check', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let compatible!: () => void
    mocks.ensureCompatible.mockImplementation(
      () =>
        new Promise((resolve) => {
          compatible = () => resolve()
        })
    )
    void retireStructuredAgentSessionTab({
      target: { kind: 'environment', environmentId: 'server-1' },
      worktreeId: 'wt-1',
      sessionId: 'session-1'
    })
    await vi.advanceTimersByTimeAsync(15_000)
    compatible()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.callRuntime).not.toHaveBeenCalled()
    vi.useRealTimers()
    warn.mockRestore()
  })

  it('keeps a chat the host says it does not list hidden only for a limited time, with no read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.callRuntime.mockRejectedValue(
      Object.assign(new Error('tab_not_found'), { code: 'tab_not_found' })
    )
    beginStructuredAgentSessionTabClose({
      target,
      worktreeId: 'wt-1',
      sessionId: 'session-1',
      provisional: false
    })
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(closing(LOCAL_STRUCTURED_SESSION_OWNER)).toBe(true)
    expect(mocks.reacceptLocal).not.toHaveBeenCalled()
    expect(
      isWebSessionCloseIntentPending(
        { environmentId: LOCAL_STRUCTURED_SESSION_OWNER },
        'wt-1',
        'agent-session:session-1',
        Date.now() + 20_001
      )
    ).toBe(false)
    warn.mockRestore()
  })

  it('retires an unmounted created reader only on the owning host', async () => {
    const local = getStructuredAgentSessionReadOwner('session-1', target)
    const remoteTarget = { kind: 'environment', environmentId: 'server-1' } as const
    const remote = getStructuredAgentSessionReadOwner('session-1', remoteTarget)
    const dispose = vi.spyOn(local, 'dispose')
    retireStructuredAgentSessionTab({ target, worktreeId: 'wt-1', sessionId: 'session-1' })
    expect(findStructuredAgentSessionReadOwner('session-1', target)).toBeUndefined()
    expect(findStructuredAgentSessionReadOwner('session-1', remoteTarget)).toBe(remote)
    expect(dispose).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(mocks.closeSession).toHaveBeenCalledWith(target, 'session-1'))
  })

  it('still closes the host tab if reader disposal fails', async () => {
    const owner = getStructuredAgentSessionReadOwner('session-1', target)
    vi.spyOn(owner, 'dispose').mockImplementation(() => {
      throw new Error('subscription cleanup failed')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() =>
      retireStructuredAgentSessionTab({ target, worktreeId: 'wt-1', sessionId: 'session-1' })
    ).not.toThrow()
    expect(findStructuredAgentSessionReadOwner('session-1', target)).toBeUndefined()
    await vi.waitFor(() => expect(mocks.callRuntime).toHaveBeenCalled())
    expect(mocks.closeSession).toHaveBeenCalledWith(target, 'session-1')
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
