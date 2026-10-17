// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HostCreateSupport } from '@/lib/structured-agent-session-host-admission'

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: unknown) => Promise<unknown>>()
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionCreateMessage: async () => true
}))
vi.mock('@/lib/structured-agent-session-host-admission', () => ({
  askHostCreateSupport: async (): Promise<HostCreateSupport> => ({ kind: 'admitted' })
}))
vi.mock('@/runtime/structured-session-tab-inventory', () => ({
  readStructuredSessionTabInventory: async () => []
}))
vi.mock('@/runtime/structured-agent-session-host-capability', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useStructuredAgentSessionHostCapability: () => true
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      // The account's saved pick, which create seeds.
      settings: { nativeChatSessionOptions: { claude: { model: 'sonnet' } } },
      unifiedTabsByWorktree: {},
      seedNativeChatLaunchDraft: vi.fn(),
      clearNativeChatLaunchDraft: vi.fn()
    }),
    subscribe: () => () => {}
  }
}))
vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import {
  CreateIntentParams,
  SendParams,
  SetOptionParams
} from '../../../../shared/rpc-contract/structured-agent-session-params'
import type { AgentSessionHistoryPage } from '../../../../shared/agent-session-wire'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import { startStructuredAgentLaunch } from '@/lib/structured-agent-session-launch'
import { resetStructuredAgentLaunchRegistryForTests } from '@/lib/structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from '@/lib/structured-agent-session-launch-persistence'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import {
  recordHostModelCatalogSnapshot,
  resetHostModelCatalogSnapshotsForTests
} from '@/runtime/host-model-catalog-snapshots'
import {
  getStructuredAgentSessionReadOwner,
  resetStructuredAgentSessionReadOwnersForTests
} from './structured-agent-session-read-owner'
import { resetStructuredAgentSessionSendsForTests } from './structured-agent-session-message-sender'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useNativeChatProvisionalLaunch } from './use-native-chat-provisional-launch'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'
import { useStructuredAgentSessionSends } from './use-structured-agent-session-sends'

const target = { kind: 'local' } as const
const efforts = ['low', 'high'].map((value) => ({ value, label: value }))
const LISTING = {
  origin: 'probe',
  fetchedAt: 1,
  models: [
    { id: 'sonnet', label: 'Sonnet', isDefault: true, defaultEffort: 'low', efforts },
    { id: 'opus', label: 'Opus', defaultEffort: 'low', efforts }
  ]
} as const

function shown(snapshot: readonly SessionOptionDescriptor[], id: string): string | undefined {
  const kind = snapshot.find((entry) => entry.id === id)?.kind
  return kind?.type === 'select' ? kind.currentValue : undefined
}

function deferred<T>() {
  let resolve = (_value: T): void => {}
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

function createdReply(sessionId: string) {
  const cursor = { epoch: 'epoch-1', sequence: 0 }
  const page: AgentSessionHistoryPage = {
    sessionId,
    epoch: cursor.epoch,
    fence: 1,
    direction: 'tail',
    items: [],
    removedItemIds: [],
    submissions: [],
    window: { oldest: null, newest: null, nextCursor: cursor },
    liveCursor: cursor,
    hasOlder: false,
    hasNewer: false,
    latestTurn: null
  }
  return { ok: true, replayed: false, value: { sessionId, fence: 1, page } }
}

/** The new chat's pane: its launch, its picker and its composer, as the session view wires them. */
function useNewChat(
  sessionId: string,
  optionSelection: Readonly<Record<string, string>> | undefined
) {
  const { launch, transportEnabled } = useNativeChatProvisionalLaunch('workspace-1', sessionId)
  const owner = getStructuredAgentSessionReadOwner(sessionId, target)
  const fence = useSyncExternalStore(owner.subscribe, () => owner.getSnapshot().state.fence)
  const options = useStructuredAgentSessionOptions({
    agent: 'claude',
    sessionId,
    target,
    transportEnabled,
    isVisible: true,
    providerVisible: transportEnabled,
    ...(optionSelection ? { optionSelection } : {}),
    fence: transportEnabled ? fence : null,
    turnId: null,
    unloadedTurnRevisions: undefined,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every pick here is made before publish, which the launch holds; mutate is never called.
    mutate: vi.fn() as unknown as StructuredAgentSessionMutate,
    ...(launch ? { launch } : {})
  })
  const sends = useStructuredAgentSessionSends({
    sessionId,
    target,
    fence: transportEnabled ? fence : null,
    submissions: [],
    queuedMessageIds: [],
    queue: { capability: 'supported', enabled: false },
    historyLoaded: false,
    executionOptionSnapshot: options.takesSendOptions ? options.optionSnapshot : undefined
  })
  return { transportEnabled, options, sends }
}

beforeEach(() => {
  localStorage.clear()
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
  resetStructuredAgentSessionSendsForTests()
  resetStructuredAgentSessionReadOwnersForTests()
  resetHostModelCatalogSnapshotsForTests()
  recordHostModelCatalogSnapshot(target, 'claude', null, LISTING)
})
afterEach(() => {
  resetStructuredAgentSessionSendsForTests()
  resetStructuredAgentSessionReadOwnersForTests()
  mocks.call.mockReset()
})

// A slow host: the chat exists, and its status shows the create's selection, before create replies.
// The real host saves a pick, publishes its status, then replies with every saved value.
it.each([
  { host: 'an older host', statusCarriesSelection: false, sendDuringReplay: false },
  {
    host: 'a host whose status shows its selection',
    statusCarriesSelection: true,
    sendDuringReplay: false
  },
  {
    host: 'a host still taking the last pick',
    statusCarriesSelection: true,
    sendDuringReplay: true
  }
])(
  'sends the model and effort picked while the chat was being created, on $host',
  async (timing) => {
    const create = deferred<unknown>()
    const lastPick = deferred<void>()
    const sent: unknown[] = []
    let saved: Record<string, string> = {}
    const status: { selection?: Readonly<Record<string, string>>; listeners: Set<() => void> } = {
      listeners: new Set()
    }
    const publish = (): void => {
      if (timing.statusCarriesSelection) {
        status.selection = { ...saved }
      }
      status.listeners.forEach((listener) => listener())
    }
    mocks.call.mockImplementation(async (_target, method, params) => {
      if (method === 'agentSession.create') {
        saved = { ...CreateIntentParams.parse(params).options }
        publish()
        return create.promise
      }
      if (method === 'agentSession.setOption') {
        const { key, value } = SetOptionParams.parse(params)
        if (key === 'effort' && timing.sendDuringReplay) {
          await lastPick.promise
        }
        saved = { ...saved, [key]: value }
        act(publish)
        return { ok: true, value: { key, value, options: saved } }
      }
      if (method === 'agentSession.modelCatalog') {
        return LISTING
      }
      if (method === 'agentSession.send') {
        sent.push(params)
      }
      return new Promise(() => {})
    })
    const launch = startStructuredAgentLaunch('workspace-1', 'claude', {
      requestId: newAgentLaunchRequestId(),
      executionHostId: 'local'
    })
    await waitFor(() => expect(saved).toEqual({ model: 'sonnet' }))
    const { result, unmount } = renderHook(() =>
      useNewChat(
        launch.sessionId,
        useSyncExternalStore(
          (listener) => {
            status.listeners.add(listener)
            return () => status.listeners.delete(listener)
          },
          () => status.selection
        )
      )
    )
    await waitFor(() =>
      expect(shown(result.current.options.optionSnapshot, 'model')).toBe('sonnet')
    )

    await act(async () => {
      expect(await result.current.options.setStructuredOption('model', 'opus')).toBe(true)
    })
    await act(async () => {
      expect(await result.current.options.setStructuredOption('effort', 'high')).toBe(true)
    })
    create.resolve(createdReply(launch.sessionId))
    await act(async () => {
      await launch.launchResult
    })
    await waitFor(() => expect(result.current.transportEnabled).toBe(true))
    await waitFor(() =>
      expect(
        mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.setOption')
      ).toHaveLength(2)
    )
    await waitFor(() => expect(saved.effort === 'high').toBe(!timing.sendDuringReplay))

    // Never re-seeded over: the picker still shows the picks, and the first message carries them.
    expect(shown(result.current.options.optionSnapshot, 'model')).toBe('opus')
    expect(shown(result.current.options.optionSnapshot, 'effort')).toBe('high')
    act(() => {
      expect(result.current.sends.send('first message')).toBe(true)
    })
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(SendParams.parse(sent[0]).options).toMatchObject({ model: 'opus', effort: 'high' })
    lastPick.resolve()
    unmount()
  }
)
