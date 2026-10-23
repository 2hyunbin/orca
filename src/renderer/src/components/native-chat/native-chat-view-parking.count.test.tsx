import type { TerminalTab } from '../../../../shared/terminal-tab-types'
// @vitest-environment happy-dom
import {
  nativeChatViewKey,
  useNativeChatViewAdmission,
  holdNativeChatInput
} from './native-chat-view-parking-owner'
import {
  awaitSelectedNativeChatInput,
  registerNativeChatReadyInput
} from './native-chat-input-readiness'
import { handleAppMenuPasteRequest } from '@/lib/app-menu-paste'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore, type AppState } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import type * as ListenerCensus from '@/store/store-listener-census'
import type * as SessionClient from '@/runtime/structured-agent-session-client'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import StructuredAgentSessionPaneOverlayLayer from './StructuredAgentSessionPaneOverlayLayer'

const census = vi.hoisted(() => ({
  current: '',
  listeners: new Map<
    (state: AppState, previous: AppState) => void,
    { tab: string; calls: number }
  >()
}))
vi.mock('@/store/store-listener-census', async (original) => {
  const actual = await original<typeof ListenerCensus>()
  return {
    ...actual,
    installStoreListenerCensus: (api: {
      subscribe: (listener: (state: AppState, previous: AppState) => void) => () => void
    }) => {
      actual.installStoreListenerCensus(api)
      const subscribe = api.subscribe
      api.subscribe = (listener) => {
        const observation = { tab: census.current, calls: 0 }
        census.listeners.set(listener, observation)
        const unsubscribe = subscribe((state, previous) => {
          observation.calls += 1
          listener(state, previous)
        })
        return () => {
          census.listeners.delete(listener)
          unsubscribe()
        }
      }
    }
  }
})

const network = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionClient>()),
  callStructuredAgentSession: network.call,
  subscribeStructuredAgentSession: network.subscribe,
  subscribeStructuredAgentSessionStatus: network.subscribe
}))

afterEach(() => {
  cleanup()
  act(() => useAppStore.setState({ unifiedTabsByWorktree: {} }))
  vi.useRealTimers()
})

describe('real structured chat presentation population', () => {
  it('releases historical chat subscriptions, editors and roots after switching grace', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    network.call.mockImplementation(async (_target, method, args) => {
      if (method === 'agentSession.history') {
        return {
          ok: true,
          page: {
            sessionId: args.sessionId,
            epoch: 'count',
            direction: 'tail',
            items: [],
            removedItemIds: [],
            submissions: [],
            window: { oldest: null, newest: null, nextCursor: null },
            liveCursor: { epoch: 'count', sequence: 0 },
            hasOlder: false,
            hasNewer: false
          }
        }
      }
      return {}
    })
    network.subscribe.mockResolvedValue({ unsubscribe: vi.fn() })
    const tabs: Tab[] = Array.from({ length: 27 }, (_, index) => ({
      id: `count-${index}`,
      entityId: `count-session-${index}`,
      worktreeId: 'count-workspace',
      groupId: 'count-group',
      label: 'Codex',
      customLabel: null,
      color: null,
      sortOrder: index,
      createdAt: index + 1,
      contentType: 'agent-session',
      agentSessionAgent: 'codex',
      executionHostId: 'local'
    }))
    const group = (tab: Tab): TabGroup => ({
      id: 'count-group',
      worktreeId: 'count-workspace',
      activeTabId: tab.id,
      tabOrder: tabs.map((entry) => entry.id)
    })
    act(() =>
      useAppStore.setState({
        settings: getDefaultSettings('/tmp'),
        activeWorktreeId: 'count-workspace',
        unifiedTabsByWorktree: { 'count-workspace': tabs },
        groupsByWorktree: { 'count-workspace': [group(tabs[0]!)] },
        activeGroupIdByWorktree: { 'count-workspace': 'count-group' }
      })
    )
    census.current = tabs[0]!.id
    const baseline = census.listeners.size
    const view = render(
      <TooltipProvider>
        <StructuredAgentSessionPaneOverlayLayer worktreeId="count-workspace" isWorktreeActive />
      </TooltipProvider>
    )
    expect(view.container.querySelector('[data-native-chat-root]')).not.toBeNull()
    const perView = census.listeners.size - baseline
    for (const tab of tabs.slice(1)) {
      census.current = tab.id
      act(() => useAppStore.setState({ groupsByWorktree: { 'count-workspace': [group(tab)] } }))
    }
    expect(view.container.querySelectorAll('[data-native-chat-root]')).toHaveLength(27)
    const burstSubscriptions = census.listeners.size - baseline
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_001)
    })
    expect(view.container.querySelectorAll('[data-native-chat-root]')).toHaveLength(7)
    expect(view.container.querySelectorAll('[contenteditable]')).toHaveLength(7)
    const retainedSubscriptions = census.listeners.size - baseline
    expect(retainedSubscriptions).toBeLessThanOrEqual(7 * perView)
    expect(burstSubscriptions - retainedSubscriptions).toBeGreaterThan(20 * 20)
    expect(
      [...census.listeners.values()].filter((entry) => entry.tab === tabs[1]!.id)
    ).toHaveLength(0)
    act(() => useAppStore.setState((state) => ({ settings: { ...state.settings } })))
    act(() =>
      useAppStore.setState((state) => ({ agentStatusByPaneKey: { ...state.agentStatusByPaneKey } }))
    )
    expect(
      [...census.listeners.values()].filter((entry) => entry.tab === tabs[1]!.id)
    ).toHaveLength(0)
    console.log(JSON.stringify({ chats: 27, perView, burstSubscriptions, retainedSubscriptions }))
  })
})

function Candidate({ tab, visible }: { tab: Tab; visible: boolean }) {
  const admitted = useNativeChatViewAdmission(
    nativeChatViewKey(tab.id, 'local', tab.entityId),
    tab.id,
    visible
  )
  return <output data-structured-agent-session-overlay-tab-id={tab.id} data-admitted={admitted} />
}

it.each([
  { chats: 10, workspaces: 6 },
  { chats: 100, workspaces: 60 },
  { chats: 27, workspaces: 1 },
  { chats: 270, workspaces: 1 },
  { chats: 270, workspaces: 61 }
])(
  'bounds the global candidate pool at $chats chats across $workspaces workspaces, with grace before cap and finite leases',
  async ({ chats, workspaces }) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const tabs: Tab[] = Array.from({ length: chats }, (_, index) => ({
      id: `policy-${index}`,
      entityId: `session-${index}`,
      worktreeId: `folder:workspace-${index % workspaces}`,
      groupId: 'group',
      contentType: 'agent-session',
      agentSessionAgent: 'codex',
      executionHostId: 'local',
      label: `Chat ${index}`,
      customLabel: `Name ${index}`,
      color: null,
      sortOrder: index,
      createdAt: 0
    }))
    const byWorkspace: Record<string, Tab[]> = {}
    const terminals: Record<string, TerminalTab[]> = {}
    for (let index = 0; index < workspaces; index++) {
      const id = `folder:workspace-${index}`
      byWorkspace[id] = tabs.filter((tab) => tab.worktreeId === id)
      terminals[id] = Array.from({ length: 16 }, (_, slot) => ({
        id: `terminal-${index}-${slot}`,
        worktreeId: id,
        ptyId: null,
        title: 'Terminal',
        customTitle: null,
        color: null,
        sortOrder: slot,
        createdAt: 0
      }))
    }
    act(() =>
      useAppStore.setState({ unifiedTabsByWorktree: byWorkspace, tabsByWorktree: terminals })
    )
    const candidates = (active: number) => (
      <>
        {tabs.map((tab, index) => (
          <Candidate key={tab.id} tab={tab} visible={index === active} />
        ))}
      </>
    )
    const view = render(candidates(0))
    expect(view.container.querySelectorAll('[data-admitted=true]')).toHaveLength(1)
    const release = holdNativeChatInput(view.container.firstElementChild)
    for (let index = 1; index < chats; index++) {
      view.rerender(candidates(index))
    }
    expect(view.container.querySelectorAll('[data-admitted=true]')).toHaveLength(chats)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_001)
    })
    expect(view.container.querySelectorAll('[data-admitted=true]')).toHaveLength(8)
    act(release)
    expect(view.container.querySelectorAll('[data-admitted=true]')).toHaveLength(7)
    view.rerender(candidates(chats - 2))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_001)
    })
    expect(view.container.querySelectorAll('[data-admitted=true]')).toHaveLength(2)
  }
)

it('delivers cold typing and menu paste once to the returning queued/question field and cancels a changed destination', async () => {
  const tab: Tab = {
    id: 'cold-input',
    entityId: 'cold-session',
    worktreeId: 'cold-folder',
    groupId: 'cold-group',
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    executionHostId: 'local',
    label: 'Codex',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  const selected = () =>
    useAppStore.setState({
      activeWorktreeId: tab.worktreeId,
      unifiedTabsByWorktree: { [tab.worktreeId]: [tab] },
      groupsByWorktree: {
        [tab.worktreeId]: [
          { id: 'cold-group', worktreeId: tab.worktreeId, activeTabId: tab.id, tabOrder: [tab.id] }
        ]
      },
      activeGroupIdByWorktree: { [tab.worktreeId]: 'cold-group' }
    })
  act(selected)
  render(<Candidate tab={tab} visible />)
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur()
  }
  const key = new KeyboardEvent('keydown', { key: 'X', bubbles: true, cancelable: true })
  document.body.dispatchEvent(key)
  expect(key.defaultPrevented).toBe(true)
  const field = document.createElement('textarea')
  document.body.append(field)
  let changes = 0
  field.addEventListener('input', () => changes++)
  const unregister = registerNativeChatReadyInput(tab.id, () => field)
  await act(async () => {
    await Promise.resolve()
  })
  expect(field.value).toBe('X')
  expect(changes).toBe(1)
  unregister()
  field.blur()
  const read = vi.fn(async () => ' paste')
  const fallback = vi.fn()
  const paste = handleAppMenuPasteRequest({
    readClipboardText: read,
    performNativePaste: fallback,
    dispatchOwnedPasteEvent: () => false
  })
  expect(read).not.toHaveBeenCalled()
  const dispose = registerNativeChatReadyInput(tab.id, () => field)
  await expect(paste).resolves.toEqual({ status: 'handled', target: 'text-control' })
  expect(field.value).toBe('X paste')
  expect(read).toHaveBeenCalledOnce()
  expect(fallback).not.toHaveBeenCalled()
  dispose()
  field.blur()
  const cancelled = awaitSelectedNativeChatInput()
  act(() => useAppStore.setState({ activeWorktreeId: 'another-folder' }))
  await expect(cancelled).resolves.toBe(false)
  const noLateDelivery = registerNativeChatReadyInput(tab.id, () => field)
  expect(field.value).toBe('X paste')
  noLateDelivery()
  field.remove()
})
