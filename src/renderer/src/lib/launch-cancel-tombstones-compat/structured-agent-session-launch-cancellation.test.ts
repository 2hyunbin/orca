// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredLaunchSlotOwner } from '@/lib/structured-agent-session-launch-slot'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { suppressCancelledStructuredSessionTabs } from '@/runtime/structured-agent-session-tab-retirement'
import type { StructuredLaunchState } from '../structured-agent-session-launch-registry'
import {
  hasStructuredAgentSessionLaunchCancellationTombstone,
  markStructuredAgentSessionLaunchCancelled,
  retireAbsentStructuredAgentSessionLaunchCancellationTombstones,
  resetStructuredAgentLaunchRegistryForTests,
  setStructuredLaunchState
} from '../structured-agent-session-launch-registry'
import { beginStructuredAgentSessionAuthoritativeInventory } from './structured-agent-session-launch-cancellation'
import { resetStructuredAgentLaunchPersistenceForTests } from '../structured-agent-session-launch-persistence'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync/inventory-refresh'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

const layoutOwner: StructuredLaunchSlotOwner = {
  unifiedTabsByWorktree: {},
  groupsByWorktree: {},
  reorderUnifiedTabs: vi.fn()
}

const WORKTREE_ID = 'repo-1::worktree-1'
const SESSION_ID = 'session-close-race'
// A paired server keeps the window's tombstone in both builds; this machine keeps one only with
// the switch off (with it on, main hears the cancel: structured-launch-cancel-layout-owner.test.ts).
const SERVER_HOST = 'runtime:server-1'
const SERVER = { kind: 'environment', environmentId: 'server-1' } as const

function latePublication(): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'epoch-late',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: `agent-session:${SESSION_ID}`,
    activeTabType: 'agent-session',
    tabs: [
      {
        type: 'agent-session',
        id: `agent-session:${SESSION_ID}`,
        title: 'Codex Chat',
        sessionId: SESSION_ID,
        agent: 'codex',
        isActive: true
      }
    ]
  }
}

describe('structured launch cancellation retirement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentLaunchRegistryForTests()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        runtime: {
          call: vi.fn().mockResolvedValue({ ok: true, result: {} })
        }
      }
    })
  })

  it('keeps a paired server’s late publication suppressed until the cancelled launch settles', async () => {
    let resolveLaunch!: (receipt: { sessionId: string; fence: number }) => void
    const launchPromise = new Promise<{ sessionId: string; fence: number }>((resolve) => {
      resolveLaunch = resolve
    })
    setStructuredLaunchState({
      identity: `codex:${WORKTREE_ID}`,
      intent: {
        worktreeId: WORKTREE_ID,
        executionHostId: SERVER_HOST,
        target: SERVER,
        sessionId: SESSION_ID,
        agent: 'codex',
        params: {
          envelope: {
            sessionId: SESSION_ID,
            clientOperationId: 'operation-close-race',
            expectedRuntimeFence: null,
            payloadFingerprint: 'fingerprint-close-race'
          },
          worktree: `id:${WORKTREE_ID}`,
          agent: 'codex'
        }
      },
      promptDelivery: 'auto-submit',
      callers: {
        outcome: 'pending',
        attempt: { kind: 'first', requestId: 'plus-pick', stagedPrompt: null },
        entries: new Set(),
        promptDeliveryResults: new Set(),
        onSettled: () => undefined
      },
      promise: launchPromise,
      visibilityUnknown: false,
      cancelled: false,
      selection: { held: {} }
    } satisfies StructuredLaunchState)

    const beforeCancel = beginStructuredAgentSessionAuthoritativeInventory()
    expect(
      retireAbsentStructuredAgentSessionLaunchCancellationTombstones(
        new Set(),
        beforeCancel,
        SERVER_HOST
      )
    ).toBe(false)
    markStructuredAgentSessionLaunchCancelled(WORKTREE_ID, SESSION_ID, SERVER_HOST, layoutOwner)
    const afterCancel = beginStructuredAgentSessionAuthoritativeInventory()
    expect(
      retireAbsentStructuredAgentSessionLaunchCancellationTombstones(
        new Set(),
        afterCancel,
        SERVER_HOST
      )
    ).toBe(false)
    expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(true)

    resolveLaunch({ sessionId: SESSION_ID, fence: 1 })
    await Promise.resolve()
    const suppressed = suppressCancelledStructuredSessionTabs(latePublication(), SERVER)
    expect(suppressed.tabs).toEqual([])
    expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(true)
    expect(
      retireAbsentStructuredAgentSessionLaunchCancellationTombstones(
        new Set(),
        beforeCancel,
        SERVER_HOST
      )
    ).toBe(false)

    const afterSettlement = beginStructuredAgentSessionAuthoritativeInventory()
    expect(
      retireAbsentStructuredAgentSessionLaunchCancellationTombstones(
        new Set(),
        afterSettlement,
        SERVER_HOST
      )
    ).toBe(true)
    expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(
      false
    )
  })

  // A runtime refused its chats answers with no chat rows; that absence is not the host's answer.
  // Switch on, this machine keeps no tombstone: main's fence is in its close-before-create test.
  it.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
    'keeps a tombstone through an inventory that cannot list chats',
    async () => {
      setStructuredLaunchState({
        identity: `codex:${WORKTREE_ID}`,
        intent: {
          worktreeId: WORKTREE_ID,
          executionHostId: 'local',
          target: { kind: 'local' },
          sessionId: SESSION_ID,
          agent: 'codex',
          params: {
            envelope: {
              sessionId: SESSION_ID,
              clientOperationId: 'operation-unverifiable',
              expectedRuntimeFence: null,
              payloadFingerprint: 'fingerprint-unverifiable'
            },
            worktree: `id:${WORKTREE_ID}`,
            agent: 'codex'
          }
        },
        promptDelivery: 'auto-submit',
        callers: {
          outcome: 'pending',
          attempt: { kind: 'first', requestId: 'plus-pick', stagedPrompt: null },
          entries: new Set(),
          promptDeliveryResults: new Set(),
          onSettled: () => undefined
        },
        promise: Promise.resolve({ sessionId: SESSION_ID, fence: 1 }),
        visibilityUnknown: false,
        cancelled: false,
        selection: { held: {} }
      } satisfies StructuredLaunchState)
      markStructuredAgentSessionLaunchCancelled(WORKTREE_ID, SESSION_ID, 'local', layoutOwner)
      await new Promise((resolve) => setTimeout(resolve, 0))
      const frame = (unverifiable: boolean): RuntimeMobileSessionTabsResult => ({
        ...latePublication(),
        activeTabId: null,
        activeTabType: null,
        tabs: [],
        ...(unverifiable ? { agentSessionsUnverifiable: true as const } : {})
      })
      const call = vi.fn()
      Object.defineProperty(window, 'api', { configurable: true, value: { runtime: { call } } })

      call.mockResolvedValue({
        ok: true,
        result: { snapshots: [frame(true)], authoritative: true }
      })
      await refreshLocalStructuredSessionTabs()
      expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(
        true
      )

      call.mockResolvedValue({
        ok: true,
        result: { snapshots: [frame(false)], authoritative: true }
      })
      await refreshLocalStructuredSessionTabs()
      expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(
        false
      )
    }
  )

  it.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
    'drains a restored cancellation before a newer inventory retires it',
    async () => {
      markStructuredAgentSessionLaunchCancelled(WORKTREE_ID, SESSION_ID, 'local', layoutOwner)
      resetStructuredAgentLaunchRegistryForTests()
      resetStructuredAgentLaunchPersistenceForTests()

      const close = Promise.withResolvers<void>()
      const call = vi.fn(({ method }: { method: string }) => {
        if (method === 'agentSession.close') {
          return close.promise.then(() => ({ ok: true, result: { ok: true } }))
        }
        return Promise.resolve({ ok: true, result: { snapshots: [], authoritative: true } })
      })
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { runtime: { call } }
      })

      await refreshLocalStructuredSessionTabs(undefined, { authoritative: true })

      expect(call.mock.calls.map(([request]) => request.method)).toEqual([
        'agentSession.close',
        'session.tabs.listAll'
      ])
      expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(
        true
      )

      // The close shares the host's session lane with create, so settlement drains a late attach.
      close.resolve()
      await close.promise
      await new Promise((resolve) => setTimeout(resolve, 0))
      await refreshLocalStructuredSessionTabs()

      expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(
        false
      )
      expect(
        call.mock.calls.filter(([request]) => request.method === 'agentSession.close')
      ).toHaveLength(1)
    }
  )

  it.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
    'tells main of a local cancel at once, so the next inventory has nothing to drain',
    async () => {
      const call = vi.fn(({ method }: { method: string }) =>
        Promise.resolve(
          method === 'session.tabs.listAll'
            ? { ok: true, result: { snapshots: [], authoritative: true } }
            : { ok: true, result: { ok: true } }
        )
      )
      Object.defineProperty(window, 'api', { configurable: true, value: { runtime: { call } } })
      markStructuredAgentSessionLaunchCancelled(WORKTREE_ID, SESSION_ID, 'local', layoutOwner)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(
        false
      )

      await refreshLocalStructuredSessionTabs(undefined, { authoritative: true })
      expect(call.mock.calls.map(([request]) => request.method)).toEqual([
        'agentSession.close',
        'session.tabs.close',
        'session.tabs.listAll'
      ])
    }
  )
})
