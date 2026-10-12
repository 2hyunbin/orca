// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type * as StructuredAgentSessionClientModule from './structured-agent-session-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

const mocks = vi.hoisted(() => ({
  closeSession:
    vi.fn<(target: RuntimeClientTarget, sessionId: string) => Promise<'closed' | 'unsupported'>>(),
  callRuntime:
    vi.fn<(target: RuntimeClientTarget, method: string, params?: unknown) => Promise<unknown>>()
}))

vi.mock('@/lib/structured-agent-session-launch-prompt', () => ({
  discardStructuredAgentSessionChatSends: vi.fn()
}))
vi.mock('./structured-agent-session-close', () => ({
  closeStructuredAgentSession: mocks.closeSession
}))
vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntime,
  ensureRuntimeEnvironmentCompatible: async () => {}
}))
// A host without close-by-id, so the chat's close is also sent as its own command.
vi.mock('./structured-agent-session-client', async (importOriginal) => ({
  ...(await importOriginal<typeof StructuredAgentSessionClientModule>()),
  readSessionTabsCloseAgentSessionCapability: async () => ({ supported: false })
}))
vi.mock('./runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: (worktreeId: string) => `id:${worktreeId}`
}))

import {
  getStructuredAgentSessionLaunchLifecycle,
  hasStructuredAgentSessionLaunchCancellationTombstone,
  markStructuredAgentSessionLaunchCancelled,
  resetStructuredAgentLaunchRegistryForTests,
  retireAbsentStructuredAgentSessionLaunchCancellationTombstones
} from '@/lib/structured-agent-session-launch-registry'
import {
  beginStructuredAgentSessionAuthoritativeInventory,
  resetStructuredAgentLaunchCancellationForTests,
  startStructuredAgentLaunchCancellationCleanup
} from '@/lib/structured-agent-session-launch-cancellation'
import {
  resetStructuredAgentLaunchPersistenceForTests,
  writeStructuredAgentLaunchRecord
} from '@/lib/structured-agent-session-launch-persistence'
import { acceptPairedHostStructuredSessions } from './structured-agent-session-tab-retirement'

const SERVER: RuntimeClientTarget = { kind: 'environment', environmentId: 'server-1' }
const SERVER_HOST = 'runtime:server-1'
const WORKTREE = 'wt-remote'

function serverFrame(
  sessionIds: readonly string[] = ['remote-chat']
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: sessionIds.map((sessionId) => ({
      type: 'agent-session' as const,
      id: `agent-session:${sessionId}`,
      title: 'Claude Chat',
      sessionId,
      agent: 'claude' as const,
      isActive: false
    }))
  }
}

/** A renderer reload: in-memory launch state is gone, localStorage survives. */
function reload(): void {
  resetStructuredAgentLaunchPersistenceForTests()
  resetStructuredAgentLaunchCancellationForTests()
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mocks.closeSession.mockResolvedValue('closed')
  mocks.callRuntime.mockResolvedValue(undefined)
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
})

describe('a chat closed before its create landed on a paired server', () => {
  it("survives this machine's inventory, so the server's late frame is still suppressed", async () => {
    markStructuredAgentSessionLaunchCancelled(WORKTREE, 'remote-chat', SERVER_HOST)
    // A local chat launch or resubscribe: an authoritative census of this machine only.
    retireAbsentStructuredAgentSessionLaunchCancellationTombstones(
      new Set(['some-local-chat']),
      beginStructuredAgentSessionAuthoritativeInventory(),
      'local'
    )

    const applied = acceptPairedHostStructuredSessions(serverFrame(), 'server-1')

    expect(applied.tabs).toEqual([])
    await vi.waitFor(() =>
      expect(mocks.closeSession).toHaveBeenCalledWith(SERVER, 'remote-chat', expect.any(Object))
    )
  })

  // A tombstone guards a random session id, so it is inert once stale; its 30-day TTL ends it.
  it('after a reload is closed on the server when the chat appears, never on this machine', async () => {
    markStructuredAgentSessionLaunchCancelled(WORKTREE, 'remote-chat', SERVER_HOST)
    reload()

    const localCleanup = vi.fn(async () => 'closed')
    startStructuredAgentLaunchCancellationCleanup('local', localCleanup)
    expect(localCleanup).not.toHaveBeenCalled()

    const applied = acceptPairedHostStructuredSessions(serverFrame(), 'server-1')

    expect(applied.tabs).toEqual([])
    await vi.waitFor(() =>
      expect(mocks.closeSession).toHaveBeenCalledWith(SERVER, 'remote-chat', expect.any(Object))
    )
    expect(mocks.closeSession).not.toHaveBeenCalledWith({ kind: 'local' }, 'remote-chat')
    expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE, 'remote-chat')).toBe(true)
  })
})

describe('a paired server publishing a chat whose launch outcome is unknown', () => {
  function pendingRecord(executionHostId: 'runtime:server-1' | 'local'): void {
    writeStructuredAgentLaunchRecord({
      sessionId: 'remote-chat',
      executionHostId,
      agent: 'claude',
      lifecycle: 'pending',
      clientOperationId: 'op-1',
      payloadFingerprint: 'fp-1',
      expectedRuntimeFence: null
    })
    reload()
  }

  it('settles the launch after a reload, as this machine settles its own', () => {
    pendingRecord(SERVER_HOST)
    expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE, 'remote-chat')).toBe(
      'visibility-unknown'
    )

    acceptPairedHostStructuredSessions(serverFrame(), 'server-1')

    expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE, 'remote-chat')).toBeNull()
  })

  it('leaves a launch sent to another host to that host', () => {
    pendingRecord('local')

    acceptPairedHostStructuredSessions(serverFrame(), 'server-1')

    expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE, 'remote-chat')).toBe(
      'visibility-unknown'
    )
  })
})
