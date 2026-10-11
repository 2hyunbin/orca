import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ remoteCall: vi.fn(), localCall: vi.fn(), reread: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ activeWorktreeId: 'folder:one' }) }
}))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))
vi.mock('@/lib/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionById: vi.fn()
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => null,
  getExecutionHostIdForWorktree: () => 'local'
}))
vi.mock('@/lib/structured-agent-session-launch-registry', () => ({
  hasStructuredAgentSessionLaunchCancellationTombstone: () => false,
  markStructuredAgentSessionLaunchCancelled: vi.fn()
}))
vi.mock('@/lib/structured-agent-session-launch-prompt', () => ({
  discardStructuredAgentSessionChatSends: vi.fn()
}))
vi.mock('@/lib/structured-agent-session-launch-publication', () => ({
  markStructuredAgentSessionLaunchesPublished: vi.fn(),
  publishedStructuredSessions: () => []
}))
vi.mock('@/components/native-chat/structured-agent-session-message-sender', () => ({
  stopStructuredAgentSessionSends: vi.fn()
}))
vi.mock('@/components/native-chat/structured-agent-session-read-owner-registry', () => ({
  retireStructuredAgentSessionReadOwner: vi.fn()
}))
vi.mock('./local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionWorktreeTabs: vi.fn()
}))
vi.mock('./host-session-tab-close', async (original) => ({
  ...(await original()),
  rereadHostSessionTabs: mocks.reread
}))
vi.mock('./runtime-rpc-subscribe', () => ({ subscribeRuntimeRpc: vi.fn() }))

import {
  beginStructuredAgentSessionTabClose,
  retireStructuredAgentSessionTab
} from './structured-agent-session-tab-retirement'
import { revealStructuredSession } from '@/lib/activate-ai-vault-structured-session'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import {
  clearRuntimeEnvironmentConnectionGenerations,
  setRuntimeEnvironmentConnectionGenerationForTests
} from '@/store/slices/runtime-status-connection-generation'
import { setLocalRuntimeCapabilitiesForTests } from './local-runtime-capabilities'
import {
  beginWebSessionCloseIntent,
  filterWebSessionCloseIntents,
  isWebSessionCloseIntentPending,
  resetWebSessionCloseIntentForTests,
  settleWebSessionCloseIntent
} from './web-session-close-intent'
import { LOCAL_STRUCTURED_SESSION_OWNER } from './local-structured-session-owner'
import { SESSION_TABS_CLOSE_AGENT_SESSION_BY_ID_RUNTIME_CAPABILITY as CLOSE_CAPABILITY } from '../../../shared/session-tabs-close-capabilities'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION,
  STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'

const local = { kind: 'local' } as const
const paired = { kind: 'environment', environmentId: 'env' } as const
const chat = 'agent-session:chat'
const workspace = 'folder:one'
const localOwner = { environmentId: LOCAL_STRUCTURED_SESSION_OWNER }
const pairedOwner = { environmentId: 'env', pairingRevision: 10 }
const target = { worktreeId: workspace, sessionId: 'chat' }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((answer) => {
    resolve = answer
  })
  return { promise, resolve }
}

function status(runtimeId = 'peer', closesById = true) {
  return {
    id: 'status',
    ok: true,
    _meta: { runtimeId },
    result: {
      runtimeId,
      graphStatus: 'ready',
      rendererGraphEpoch: 1,
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0,
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
      capabilities: [
        STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
        STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY,
        ...(closesById ? [CLOSE_CAPABILITY] : [])
      ]
    } satisfies RuntimeStatus
  }
}

function ok(method: string, result: unknown = undefined) {
  return { id: method, ok: true, result, _meta: { runtimeId: 'peer' } }
}

const pending = (owner = localOwner): boolean =>
  isWebSessionCloseIntentPending(owner, workspace, chat, Date.now())
const closing = (host = local) => ({ target: host, ...target, provisional: false })
const methods = (): string[] => mocks.remoteCall.mock.calls.map(([args]) => args.method)

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  resetWebSessionCloseIntentForTests()
  clearRuntimeCompatibilityCacheForTests()
  clearRuntimeEnvironmentConnectionGenerations()
  replaceRuntimeEnvironmentRevisions([])
  replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 1, pairingRevision: 10 }])
  setLocalRuntimeCapabilitiesForTests([CLOSE_CAPABILITY])
  mocks.reread.mockResolvedValue(undefined)
  mocks.localCall.mockImplementation(({ method }) => Promise.resolve(ok(method, { ok: true })))
  mocks.remoteCall.mockImplementation(({ method }) =>
    Promise.resolve(method === 'status.get' ? status() : ok(method, { ok: true }))
  )
  vi.stubGlobal('window', {
    api: {
      runtime: { call: mocks.localCall, getStatus: vi.fn() },
      runtimeEnvironments: { call: mocks.remoteCall }
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it.each([true, false])(
  'abandons a close when its capability answer outlives a different-host pairing (supported=%s)',
  async (supported) => {
    const probe = deferred<ReturnType<typeof status>>()
    mocks.remoteCall.mockImplementation(({ method }) =>
      method === 'status.get' ? probe.promise : Promise.resolve(ok(method))
    )
    const close = retireStructuredAgentSessionTab({ target: paired, ...target })
    await vi.waitFor(() => expect(methods()).toEqual(['status.get']))
    expect(mocks.remoteCall.mock.calls[0][0].expectedEnvironmentPairingRevision).toBe(10)
    replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 1, pairingRevision: 11 }], {
      retired: ['env'],
      sameHost: []
    })
    clearRuntimeCompatibilityCacheForTests()
    probe.resolve(status('old-peer', supported))
    expect((await close).status).toBe('rejected')
    expect(methods()).toEqual(['status.get'])
  }
)

it('abandons a close when the runtime incarnation changes under the same pairing', async () => {
  const probe = deferred<ReturnType<typeof status>>()
  mocks.remoteCall.mockImplementation(({ method }) =>
    method === 'status.get' ? probe.promise : Promise.resolve(ok(method))
  )
  const close = retireStructuredAgentSessionTab({ target: paired, ...target })
  setRuntimeEnvironmentConnectionGenerationForTests('env', 1)
  probe.resolve(status('old-runtime'))
  expect((await close).status).toBe('rejected')
  expect(methods()).toEqual(['status.get'])
})

it.each([true, false])(
  'follows a proven same-host rotation and stamps both close routes with the proven runtime (supported=%s)',
  async (supported) => {
    const probe = deferred<ReturnType<typeof status>>()
    mocks.remoteCall.mockImplementation(({ method }) =>
      method === 'status.get' ? probe.promise : Promise.resolve(ok(method))
    )
    const close = retireStructuredAgentSessionTab({ target: paired, ...target })
    replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 1, pairingRevision: 11 }], {
      retired: [],
      sameHost: [{ id: 'env', fromRevision: 10, toRevision: 11 }]
    })
    probe.resolve(status('same-runtime', supported))
    expect((await close).status).toBe('fulfilled')
    await vi.waitFor(() =>
      expect(methods()).toContain(supported ? 'session.tabs.close' : 'agentSession.close')
    )
    for (const [args] of mocks.remoteCall.mock.calls.filter(
      ([args]) => args.method !== 'status.get'
    )) {
      expect(args.expectedEnvironmentPairingRevision).toBe(11)
      expect(args.expectedEnvironmentRuntimeId).toBe('same-runtime')
    }
    expect(methods().filter((method) => method === 'agentSession.close')).toHaveLength(
      supported ? 0 : 1
    )
  }
)

it('does not deduplicate a replacement host close against the previous host promise', async () => {
  const oldAnswer = deferred<ReturnType<typeof ok>>()
  mocks.remoteCall.mockImplementation(({ method }) =>
    method === 'session.tabs.close' ? oldAnswer.promise : Promise.resolve(status())
  )
  const oldClose = retireStructuredAgentSessionTab({ target: paired, ...target })
  await vi.waitFor(() => expect(methods()).toContain('session.tabs.close'))
  replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 1, pairingRevision: 11 }], {
    retired: ['env'],
    sameHost: []
  })
  clearRuntimeCompatibilityCacheForTests()
  const newClose = retireStructuredAgentSessionTab({ target: paired, ...target })
  expect(newClose).not.toBe(oldClose)
  await vi.waitFor(() =>
    expect(methods().filter((method) => method === 'session.tabs.close')).toHaveLength(2)
  )
  oldAnswer.resolve(ok('session.tabs.close'))
  await Promise.all([oldClose, newClose])
})

it('preserves a newer close made while the earlier reveal reply is outstanding', async () => {
  const answer = deferred<ReturnType<typeof ok>>()
  mocks.localCall.mockReturnValue(answer.promise)
  const reveal = revealStructuredSession({ target: local, ...target })
  await vi.waitFor(() => expect(mocks.localCall).toHaveBeenCalledOnce())
  const newer = beginWebSessionCloseIntent(localOwner, workspace, chat, Date.now())!
  answer.resolve(ok('agentSession.reveal', { ok: true }))
  expect(await reveal).toBe('revealed')
  expect(pending()).toBe(true)
  expect(
    filterWebSessionCloseIntents(localOwner, workspace, [{ id: chat }], (tab) => tab.id, Date.now())
  ).toEqual([])
  expect(settleWebSessionCloseIntent(newer, 'closed', Date.now())).toBe(true)
  expect(mocks.reread).not.toHaveBeenCalled()
})

it('preserves a newer close made while a successful reveal is checking local capabilities', async () => {
  beginWebSessionCloseIntent(localOwner, workspace, chat, Date.now())
  const capability = deferred<ReturnType<typeof status>['result']>()
  setLocalRuntimeCapabilitiesForTests(null)
  window.api.runtime.getStatus = vi.fn(() => capability.promise)
  const reveal = revealStructuredSession({ target: local, ...target })
  await vi.waitFor(() => expect(window.api.runtime.getStatus).toHaveBeenCalledOnce())
  const newer = beginWebSessionCloseIntent(localOwner, workspace, chat, Date.now())!
  capability.resolve(status().result)
  expect(await reveal).toBe('revealed')
  expect(pending()).toBe(true)
  expect(settleWebSessionCloseIntent(newer, 'closed', Date.now())).toBe(true)
  expect(mocks.reread).not.toHaveBeenCalled()
})

it('does not apply an old-pair reveal answer to the replacement pairing close', async () => {
  const answer = deferred<ReturnType<typeof ok>>()
  mocks.remoteCall.mockImplementation(({ method }) =>
    method === 'status.get' ? Promise.resolve(status()) : answer.promise
  )
  const reveal = revealStructuredSession({ target: paired, ...target })
  await vi.waitFor(() => expect(methods()).toContain('agentSession.reveal'))
  replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 1, pairingRevision: 11 }], {
    retired: ['env'],
    sameHost: []
  })
  const newerOwner = { environmentId: 'env', pairingRevision: 11 }
  beginWebSessionCloseIntent(newerOwner, workspace, chat, Date.now())
  answer.resolve(ok('agentSession.reveal', { ok: true }))
  expect(await reveal).toBe('unreachable')
  expect(pending(newerOwner)).toBe(true)
  expect(mocks.reread).not.toHaveBeenCalled()
})

it('waits for the previous close answer before reveal and sends a fresh close after reopening', async () => {
  const closeAnswer = deferred<ReturnType<typeof ok>>()
  mocks.remoteCall.mockImplementation(({ method }) =>
    method === 'status.get'
      ? Promise.resolve(status())
      : method === 'session.tabs.close'
        ? closeAnswer.promise
        : Promise.resolve(ok(method, { ok: true }))
  )
  beginStructuredAgentSessionTabClose({ target: paired, ...target, provisional: false })
  const first = retireStructuredAgentSessionTab({ target: paired, ...target })
  await vi.waitFor(() => expect(methods()).toContain('session.tabs.close'))
  const reveal = revealStructuredSession({ target: paired, ...target })
  await Promise.resolve()
  expect(methods()).not.toContain('agentSession.reveal')
  closeAnswer.resolve(ok('session.tabs.close'))
  expect(await reveal).toBe('revealed')
  expect(pending(pairedOwner)).toBe(false)
  mocks.remoteCall.mockImplementation(({ method }) =>
    Promise.resolve(method === 'status.get' ? status() : ok(method))
  )
  beginStructuredAgentSessionTabClose({ target: paired, ...target, provisional: false })
  const second = retireStructuredAgentSessionTab({ target: paired, ...target })
  expect(second).not.toBe(first)
  await second
  expect(methods().filter((method) => method === 'session.tabs.close')).toHaveLength(2)
})

it('orders reveal after a local close still waiting for its first capability answer', async () => {
  const capability = deferred<ReturnType<typeof status>['result']>()
  setLocalRuntimeCapabilitiesForTests(null)
  window.api.runtime.getStatus = vi.fn(() => capability.promise)
  beginStructuredAgentSessionTabClose(closing())
  const reveal = revealStructuredSession({ target: local, ...target })
  expect(mocks.localCall).not.toHaveBeenCalled()
  capability.resolve(status().result)
  expect(await reveal).toBe('revealed')
  expect(mocks.localCall.mock.calls.map(([args]) => args.method)).toEqual([
    'session.tabs.close',
    'agentSession.reveal'
  ])
  expect(pending()).toBe(false)
})

it('continues reveal after the earlier close rejects', async () => {
  mocks.localCall.mockImplementation(({ method }) =>
    method === 'session.tabs.close'
      ? Promise.reject(new Error('close failed'))
      : Promise.resolve(ok(method, { ok: true }))
  )
  beginStructuredAgentSessionTabClose(closing())
  expect(await revealStructuredSession({ target: local, ...target })).toBe('revealed')
  expect(mocks.localCall.mock.calls.map(([args]) => args.method)).toEqual([
    'session.tabs.close',
    'agentSession.reveal'
  ])
})

it('does not dispatch reveal when its wait for an earlier unsent close expires', async () => {
  vi.useFakeTimers()
  const capability = deferred<ReturnType<typeof status>['result']>()
  setLocalRuntimeCapabilitiesForTests(null)
  window.api.runtime.getStatus = vi.fn(() => capability.promise)
  beginStructuredAgentSessionTabClose(closing())
  const close = retireStructuredAgentSessionTab({ target: local, ...target })
  const reveal = revealStructuredSession({ target: local, ...target })
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await reveal).toBe('unreachable')
  expect(mocks.localCall).not.toHaveBeenCalled()
  capability.resolve(status().result)
  await close
  expect(mocks.localCall.mock.calls.map(([args]) => args.method)).toEqual(['session.tabs.close'])
})

it('allows a retry after a delayed close reply outlives the bounded reveal wait', async () => {
  vi.useFakeTimers()
  const answer = deferred<ReturnType<typeof ok>>()
  mocks.localCall.mockImplementation(({ method }) =>
    method === 'session.tabs.close' ? answer.promise : Promise.resolve(ok(method, { ok: true }))
  )
  beginStructuredAgentSessionTabClose(closing())
  const close = retireStructuredAgentSessionTab({ target: local, ...target })
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.localCall.mock.calls.map(([args]) => args.method)).toEqual(['session.tabs.close'])
  const reveal = revealStructuredSession({ target: local, ...target })
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await reveal).toBe('unreachable')
  expect(pending()).toBe(true)
  answer.resolve(ok('session.tabs.close'))
  await close
  expect(await revealStructuredSession({ target: local, ...target })).toBe('revealed')
  expect(mocks.localCall.mock.calls.map(([args]) => args.method)).toEqual([
    'session.tabs.close',
    'agentSession.reveal'
  ])
  expect(pending()).toBe(false)
})
