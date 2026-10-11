import { describe, expect, it, vi } from 'vitest'
import { SessionTabCloseLedger } from '../../../src/shared/session-tab-close-ledger'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse, RpcSuccess } from '../transport/types'
import type { MobileSessionTab, SessionTabsResult } from './mobile-session-route-types'
import { MobileSessionTabsStreamHealth } from './mobile-session-tabs-stream-health'
import { runAcceptedMobileSessionTabsEffects } from './mobile-session-tabs-accepted-effects'
import { acceptSessionSnapshot, type AppliedSnapshotMarker } from './session-tab-snapshot-gate'

const PARTITION = 'host/workspace'
const CLOSED_TAB = 'closed-tab'
const META = { runtimeId: 'runtime-1' }
const replyClasses = ['failed', 'transport', 'stale', 'unusable'] as const

function snapshot(version: number): SessionTabsResult {
  return {
    worktree: 'folder:workspace',
    publicationEpoch: 'renderer',
    snapshotVersion: version,
    tabs: [],
    activeTabId: null,
    activeTabType: null
  }
}

function success(version: number): RpcSuccess {
  return { id: 'list', ok: true, result: snapshot(version), _meta: META }
}

function recoveryHarness() {
  let now = 0
  let pendingBrowserPageId: string | null = null
  const activateBrowserTab = vi.fn()
  const ledger = new SessionTabCloseLedger()
  const marker: AppliedSnapshotMarker = { epoch: null, version: -1 }
  const requests: Array<{
    resolve: (reply: RpcResponse) => void
    reject: (error: Error) => void
  }> = []
  const sendRequest = vi.fn(
    () =>
      new Promise<RpcResponse>((resolve, reject) => {
        requests.push({ resolve, reject })
      })
  )
  const hasRecoveryNeed = () => ledger.hasPending(PARTITION, now) || pendingBrowserPageId !== null
  const controller = new MobileSessionTabsStreamHealth<SessionTabsResult, MobileSessionTab>({
    client: mountFixture<RpcClient>({ sendRequest, getGeneration: () => 1 }),
    scope: 'id:folder:workspace',
    hasRecoveryNeed,
    apply(value) {
      if (!value || !Array.isArray(value.tabs) || !acceptSessionSnapshot(value, marker)) {
        return { accepted: false }
      }
      return { accepted: true, effectiveTabs: value.tabs }
    },
    consumeAccepted(_value, effectiveTabs, source) {
      runAcceptedMobileSessionTabsEffects({
        effectiveTabs,
        source,
        getPendingBrowserPageId: () => pendingBrowserPageId,
        clearPendingBrowserPageId: () => {
          pendingBrowserPageId = null
        },
        activateBrowserTab,
        markActiveMarkdownStale: () => {}
      })
    }
  })
  controller.setReconciliationActive(true)
  const subscription = controller.beginSubscription()
  subscription.listener({ ...snapshot(1), type: 'updated' })
  expect(controller.isCertified()).toBe(true)
  expect(controller.poll()).toBeNull()
  const ticket = ledger.begin(PARTITION, CLOSED_TAB, now)
  if (!ticket) {
    throw new Error('Expected close ticket')
  }
  ledger.settle(ticket, 'closed', now)
  return {
    controller,
    sendRequest,
    requests,
    hasRecoveryNeed,
    activateBrowserTab,
    needBrowserPage(pageId: string) {
      pendingBrowserPageId = pageId
    },
    expireClose() {
      now = 22_001
      expect(hasRecoveryNeed()).toBe(false)
    },
    failRequest(index: number, kind: (typeof replyClasses)[number]) {
      const request = requests[index]!
      if (kind === 'transport') {
        request.reject(new Error('Connection lost'))
      } else if (kind === 'failed') {
        request.resolve({
          id: 'list',
          ok: false,
          error: { code: 'runtime_error', message: 'Unavailable' },
          _meta: META
        })
      } else {
        request.resolve({ ...success(0), result: kind === 'unusable' ? null : snapshot(0) })
      }
    }
  }
}

describe('derived tab recovery expiry', () => {
  for (const requestKind of ['poll', 'pending-recovery'] as const) {
    it.each(replyClasses)(
      `${requestKind} stops after close expiry even when the reply is %s`,
      async (replyKind) => {
        const harness = recoveryHarness()
        const request =
          requestKind === 'poll'
            ? harness.controller.poll()
            : harness.controller.requestPendingRecovery()
        expect(request).not.toBeNull()
        harness.failRequest(0, replyKind)
        await request
        expect(harness.controller.isCertified()).toBe(true)
        harness.expireClose()

        expect(harness.controller.poll()).toBeNull()
        await harness.controller.requestPendingRecovery()
        expect(harness.sendRequest).toHaveBeenCalledTimes(1)
        harness.controller.dispose()
      }
    )
  }

  it.each(replyClasses)(
    'preserves an explicit failed requirement after a %s reply',
    async (kind) => {
      const harness = recoveryHarness()
      const explicit = harness.controller.requestReconciliation()
      harness.failRequest(0, kind)
      await explicit
      harness.expireClose()

      const retry = harness.controller.poll()
      expect(retry).not.toBeNull()
      expect(harness.sendRequest).toHaveBeenCalledTimes(2)
      harness.requests[1]!.resolve(success(2))
      await retry
      expect(harness.controller.poll()).toBeNull()
      harness.controller.dispose()
    }
  )

  it('coalesces derived recovery with a newer explicit requirement and drains its trailing request', async () => {
    const harness = recoveryHarness()
    const derived = harness.controller.poll()
    const explicit = harness.controller.requestReconciliation()
    expect(explicit).toBe(derived)
    expect(harness.sendRequest).toHaveBeenCalledTimes(1)
    harness.expireClose()
    harness.requests[0]!.resolve(success(2))
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.sendRequest).toHaveBeenCalledTimes(2)
    harness.requests[1]!.resolve(success(3))
    await explicit
    expect(harness.controller.poll()).toBeNull()
    harness.controller.dispose()
  })

  it('discovers browser recovery that arrives during an older derived request', async () => {
    const harness = recoveryHarness()
    const older = harness.controller.poll()
    harness.expireClose()
    harness.needBrowserPage('new-page')
    expect(harness.controller.requestPendingRecovery()).toBe(older)
    harness.requests[0]!.resolve(success(2))
    await older
    expect(harness.hasRecoveryNeed()).toBe(true)
    expect(harness.activateBrowserTab).not.toHaveBeenCalled()

    const nextPoll = harness.controller.poll()
    expect(nextPoll).not.toBeNull()
    const browser = {
      type: 'browser' as const,
      id: 'new-browser',
      title: 'Browser',
      isActive: false,
      browserPageId: 'new-page'
    }
    harness.requests[1]!.resolve({
      ...success(3),
      result: { ...snapshot(3), tabs: [browser] }
    })
    await nextPoll
    expect(harness.activateBrowserTab).toHaveBeenCalledExactlyOnceWith(browser)
    expect(harness.hasRecoveryNeed()).toBe(false)
    expect(harness.controller.poll()).toBeNull()
    harness.controller.dispose()
  })

  it('retains degraded-stream fallback after derived close recovery has expired', async () => {
    const harness = recoveryHarness()
    harness.expireClose()
    harness.controller.beginSubscription().cancel()
    expect(harness.controller.isCertified()).toBe(false)

    const fallback = harness.controller.poll()
    expect(fallback).not.toBeNull()
    harness.requests[0]!.resolve(success(2))
    await fallback
    const nextFallback = harness.controller.poll()
    expect(nextFallback).not.toBeNull()
    harness.requests[1]!.resolve(success(3))
    await nextFallback
    expect(harness.sendRequest).toHaveBeenCalledTimes(2)
    harness.controller.dispose()
  })
})
