import type { TerminalTab } from '../../../../shared/terminal-tab-types'
// @vitest-environment happy-dom
import {
  nativeChatViewKey,
  useNativeChatViewAdmission,
  holdNativeChatInput
} from './native-chat-view-parking-owner'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore, type AppState } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import type * as ListenerCensus from '@/store/store-listener-census'
import type * as SessionClient from '@/runtime/structured-agent-session-client'
import type * as LocalCapabilities from '@/runtime/local-runtime-capabilities'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import { captureInsertionTarget } from '../dictation/dictation-insertion-target'
import { activateStructuredAgentSessionTab } from '@/lib/structured-agent-session-tab-activation'
import { createNativeChatReturnField } from './native-chat-view-state-memory'
import { legacySingleQuestionPromptItems } from './native-chat-structured-question-test-fixtures'
import { isMacPlatform } from './native-chat-shortcut'
import { changePrompt } from './native-chat-prompt-editor.test-support'
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

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn(async () => ({})) }))

vi.mock('@/runtime/local-runtime-capabilities', async (original) => {
  const actual = await original<typeof LocalCapabilities>()
  const { RUNTIME_CAPABILITIES } = await import('../../../../shared/protocol-version')
  return {
    ...actual,
    readLocalRuntimeCapabilitiesOrUnknown: () => RUNTIME_CAPABILITIES,
    ensureLocalRuntimeCapabilities: async () => RUNTIME_CAPABILITIES
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
    let holdReturnRead = false
    let finishRead: (() => void) | undefined
    network.call.mockImplementation(async (_target, method, args) => {
      if (method === 'agentSession.history') {
        if (holdReturnRead && args.sessionId === 'count-session-0') {
          await new Promise<void>((resolve) => {
            finishRead = resolve
          })
        }
        return {
          ok: true,
          page: {
            sessionId: args.sessionId,
            epoch: 'count',
            fence: 0,
            direction: 'tail',
            items:
              args.sessionId === 'count-session-1'
                ? legacySingleQuestionPromptItems.map((item) => ({
                    ...item,
                    body: { ...item.body, freeTextQuestionId: undefined }
                  }))
                : [],
            queuedMessages:
              args.sessionId === 'count-session-0'
                ? [
                    {
                      messageId: 'mail',
                      position: 1,
                      state: 'waiting',
                      body: {
                        kind: 'message',
                        role: 'user',
                        blocks: [{ type: 'text', text: 'Queued text' }]
                      }
                    }
                  ]
                : [],
            removedItemIds: [],
            submissions: [],
            window: { oldest: null, newest: null, nextCursor: null },
            liveCursor: { epoch: 'count', sequence: 0 },
            hasOlder: false,
            hasNewer: false
          }
        }
      }
      if (method === 'agentSession.queuedMessageEditHold') {
        return {
          status: args.action === 'release' ? 'released' : 'held',
          fingerprint: 'f'.repeat(64),
          leaseDurationMs: 120_000,
          remainingMs: 120_000
        }
      }
      if (method === 'agentSession.queuedMessageUpdate') {
        return {
          ok: true,
          value: { status: 'updated', messageId: 'mail', fingerprint: 'a'.repeat(64) }
        }
      }
      return { ok: true, value: {} }
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
    await act(async () => {})
    const firstRoot = view.container.querySelector<HTMLElement>('[data-native-chat-root]')!
    fireEvent.pointerDown(within(firstRoot).getByRole('button', { name: 'More actions' }))
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'Edit message' })))
    const editField = within(firstRoot).getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Edit message'
    })
    fireEvent.change(editField, { target: { value: 'Queued revision' } })
    fireEvent.mouseDown(editField)
    editField.setSelectionRange(2, 7, 'backward')
    fireEvent.mouseUp(editField)
    const input = firstRoot.querySelector<HTMLElement>('[contenteditable]')!
    fireEvent.compositionStart(input)
    changePrompt(input, '未確定')
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
    act(() =>
      useAppStore.setState((state) => ({ settings: state.settings && { ...state.settings } }))
    )
    act(() =>
      useAppStore.setState((state) => ({ agentStatusByPaneKey: { ...state.agentStatusByPaneKey } }))
    )
    expect(
      [...census.listeners.values()].filter((entry) => entry.tab === tabs[1]!.id)
    ).toHaveLength(0)
    // Selection commits before the next native task, without history or reveal-focus frames.
    await act(async () => vi.advanceTimersByTimeAsync(300_001))
    holdReturnRead = true
    await act(async () => {
      expect(
        activateStructuredAgentSessionTab({ worktreeId: 'count-workspace', tabId: tabs[0]!.id })
      ).toBe(true)
    })
    const destination = view.container.querySelector<HTMLElement>(
      '[data-structured-agent-session-overlay-tab-id="count-0"] [data-native-chat-root]'
    )!
    const typed = new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true })
    act(() => destination.dispatchEvent(typed))
    expect(typed.defaultPrevented).toBe(true)
    expect(destination.querySelector('[contenteditable]')?.textContent).toBe('未確定x')
    expect(finishRead).toBeTypeOf('function')
    for (const text of ['a', 'b']) {
      await act(async () =>
        fireEvent.paste(destination, {
          clipboardData: {
            getData: (format: string) => (format === 'text/plain' ? text : ''),
            items: [],
            files: []
          }
        })
      )
    }
    expect(destination.querySelector('[contenteditable]')?.textContent).toBe('未確定xab')
    expect(captureInsertionTarget()).toEqual({
      kind: 'contentEditable',
      element: destination.querySelector('[contenteditable]')
    })
    holdReturnRead = false
    await act(async () => finishRead?.())
    fireEvent.keyDown(destination, {
      key: 'f',
      metaKey: isMacPlatform(),
      ctrlKey: !isMacPlatform()
    })
    const find = within(destination).getByRole<HTMLInputElement>('textbox', {
      name: 'Find in chat'
    })
    expect(document.activeElement).toBe(find)
    fireEvent.change(find, { target: { value: 'needle' } })
    find.setSelectionRange(1, 3)
    await act(async () => {
      activateStructuredAgentSessionTab({ worktreeId: 'count-workspace', tabId: tabs[1]!.id })
    })
    const question = view.container.querySelector<HTMLElement>(
      '[data-structured-agent-session-overlay-tab-id="count-1"] [data-native-chat-root]'
    )!
    expect(question.querySelector('[contenteditable], input, textarea')).toBeNull()
    const choice = within(question).getByRole('button', { name: /React/ })
    choice.focus()
    const subscriptions = census.listeners.size
    fireEvent.keyDown(choice, { key: '1' })
    expect(choice.getAttribute('aria-pressed')).toBe('true')
    for (let index = 0; index < 100; index++) {
      fireEvent.keyDown(choice, { key: '2', repeat: true })
    }
    expect(choice.getAttribute('aria-pressed')).toBe('true')
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    act(() => choice.dispatchEvent(space))
    expect(space.defaultPrevented).toBe(false)
    expect(census.listeners.size).toBe(subscriptions)
    const modal = document.createElement('input')
    document.body.append(modal)
    modal.focus()
    fireEvent.keyDown(modal, { key: '2' })
    expect(document.activeElement).toBe(modal)
    expect(choice.getAttribute('aria-pressed')).toBe('true')
    modal.remove()
    // Park the acquired edit a second time, then reveal it beside a still-focused sibling.
    for (const tab of tabs.slice(10)) {
      act(() => useAppStore.setState({ groupsByWorktree: { 'count-workspace': [group(tab)] } }))
    }
    await act(async () => vi.advanceTimersByTimeAsync(30_001))
    expect(
      view.container.querySelector('[data-structured-agent-session-overlay-tab-id="count-0"]')
    ).toBeNull()
    const left = view.container.querySelector<HTMLElement>(
      '[data-structured-agent-session-overlay-tab-id="count-26"] [contenteditable]'
    )!
    left.focus()
    await act(async () =>
      useAppStore.setState({
        unifiedTabsByWorktree: {
          'count-workspace': tabs.map((tab, index) =>
            index === 0 ? { ...tab, groupId: 'right' } : tab
          )
        },
        groupsByWorktree: {
          'count-workspace': [
            group(tabs[26]!),
            {
              id: 'right',
              worktreeId: 'count-workspace',
              activeTabId: 'count-0',
              tabOrder: ['count-0']
            }
          ]
        },
        activeGroupIdByWorktree: { 'count-workspace': 'count-group' }
      })
    )
    const right = view.container.querySelector<HTMLElement>(
      '[data-structured-agent-session-overlay-tab-id="count-0"] [data-native-chat-root]'
    )!
    const restoredEdit = within(right).getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Edit message'
    })
    expect(restoredEdit.value).toBe('Queued revision')
    expect([
      restoredEdit.selectionStart,
      restoredEdit.selectionEnd,
      restoredEdit.selectionDirection
    ]).toEqual([2, 7, 'backward'])
    expect(document.activeElement).toBe(left)
    const restoredFind = within(right).getByRole<HTMLInputElement>('textbox', {
      name: 'Find in chat'
    })
    expect(restoredFind.value).toBe('needle')
    expect([restoredFind.selectionStart, restoredFind.selectionEnd]).toEqual([1, 3])
    expect(restoredEdit.closest('ul')?.scrollTop).toBe(0)
    await act(async () => fireEvent.click(within(right).getByRole('button', { name: 'Save' })))
    expect(
      network.call.mock.calls.some(
        ([, method, args]) =>
          method === 'agentSession.queuedMessageUpdate' && args.text === 'Queued revision'
      )
    ).toBe(true)
    await act(async () =>
      activateStructuredAgentSessionTab({ worktreeId: 'count-workspace', tabId: 'count-0' })
    )
    expect(document.activeElement).toBe(restoredFind)
    expect([restoredFind.selectionStart, restoredFind.selectionEnd]).toEqual([1, 3])
    console.log(JSON.stringify({ chats: 27, perView, burstSubscriptions, retainedSubscriptions }))
  })
})

function Candidate({
  tab,
  visible,
  onRender
}: {
  tab: Tab
  visible: boolean
  onRender?: () => void
}) {
  onRender?.()
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
    await act(async () => release())
    expect(view.container.querySelectorAll('[data-admitted=true]')).toHaveLength(7)
    view.rerender(candidates(chats - 2))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_001)
    })
    expect(view.container.querySelectorAll('[data-admitted=true]')).toHaveLength(2)
  }
)

it.each([27, 270])(
  'counts cold setup, fixed working-set batches and scoped structural retirement at N=%s',
  async (count) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    await act(async () => {})
    let policyVisits = 0
    let retiredCells = 0
    let sourceVisits = 0
    let comparisons = 0
    let notifications = 0
    const entries = Map.prototype[Symbol.iterator]
    const values = Map.prototype.values
    const observe = (value: unknown) => {
      if (value && typeof value === 'object' && 'leases' in value && 'hiddenSinceMs' in value) {
        policyVisits++
      }
      if (value && typeof value === 'object' && 'retired' in value && 'current' in value) {
        retiredCells++
      }
    }
    const entrySpy = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function* (
      this: Map<unknown, unknown>
    ) {
      for (const entry of entries.call(this)) {
        observe(entry[1])
        yield entry
      }
    })
    const valueSpy = vi.spyOn(Map.prototype, 'values').mockImplementation(function* (
      this: Map<unknown, unknown>
    ) {
      for (const value of values.call(this)) {
        observe(value)
        yield value
      }
    })
    const sort = Array.prototype.sort
    const sortSpy = vi.spyOn(Array.prototype, 'sort').mockImplementation(function (
      this: unknown[],
      compare
    ) {
      return sort.call(
        this,
        compare
          ? (a, b) => {
              comparisons++
              return compare(a, b)
            }
          : undefined
      )
    })
    const fields = [createNativeChatReturnField<number>(), createNativeChatReturnField<number>()]
    const tabs: Tab[] = Array.from({ length: count }, (_, index) => ({
      id: `work-${count}-${index}`,
      entityId: `s-${index}`,
      worktreeId: `folder:w-${index % 61}`,
      groupId: 'g',
      get contentType() {
        sourceVisits++
        return 'agent-session' as const
      },
      executionHostId: 'local',
      agentSessionAgent: 'codex',
      label: 'Chat',
      customLabel: null,
      color: null,
      sortOrder: index,
      createdAt: index
    }))
    const grouped: Record<string, Tab[]> = {}
    for (const tab of tabs) {
      ;(grouped[tab.worktreeId] ??= []).push(tab)
    }
    await act(async () => useAppStore.setState({ unifiedTabsByWorktree: grouped }))
    for (const tab of tabs) {
      for (const field of fields) {
        for (const scope of ['a', 'b']) {
          field(`${nativeChatViewKey(tab.id, 'local', tab.entityId)}\0${scope}`, () => 1)
        }
      }
    }
    const tree = (active = -1) => (
      <>
        {tabs.map((tab, index) => (
          <Candidate
            key={tab.id}
            tab={tab}
            visible={index === active || active === -2}
            onRender={() => notifications++}
          />
        ))}
      </>
    )
    sourceVisits = 0
    const rendered = render(tree())
    await act(async () => {})
    expect(policyVisits).toBe(0)
    expect(sourceVisits).toBe(0)
    await act(async () => rendered.rerender(tree(0)))
    await act(async () => rendered.rerender(tree(1)))
    expect(policyVisits).toBeLessThanOrEqual(6)
    const beforeLease = policyVisits
    const release = holdNativeChatInput(rendered.container.firstElementChild)
    expect(policyVisits).toBe(beforeLease)
    await act(async () => {
      release()
      release()
    })
    expect(policyVisits - beforeLease).toBe(4)
    const beforeStatus = policyVisits
    await act(async () =>
      useAppStore.setState((state) => ({ agentStatusByPaneKey: { ...state.agentStatusByPaneKey } }))
    )
    expect(policyVisits).toBe(beforeStatus)
    expect(sourceVisits).toBe(0)
    await act(async () => {
      useAppStore.setState({
        activeWorktreeId: 'folder:w-0',
        activeWorkspaceExecutionHostId: 'local'
      })
      useAppStore.setState({ activeWorktreeId: 'folder:w-1' })
    })
    expect(sourceVisits).toBe(0)
    expect(policyVisits).toBe(beforeStatus)
    await act(async () => {
      useAppStore.setState({ unifiedTabsByWorktree: { ...grouped } })
      useAppStore.setState({ unifiedTabsByWorktree: { ...grouped } })
    })
    expect(sourceVisits).toBe(count)
    sourceVisits = 0
    await act(async () => rendered.rerender(tree(-2)))
    await act(async () => rendered.rerender(tree()))
    const beforeDeadline = policyVisits
    comparisons = 0
    notifications = 0
    await act(async () => vi.advanceTimersByTimeAsync(30_001))
    expect(policyVisits - beforeDeadline).toBe(count + 6)
    expect(comparisons).toBeGreaterThan(0)
    expect(comparisons).toBeLessThan(4 * count * Math.ceil(Math.log2(count)))
    expect(notifications).toBe(count - 6)
    await act(async () => useAppStore.setState({ unifiedTabsByWorktree: {} }))
    expect(sourceVisits).toBe(0)
    expect(retiredCells).toBe(4 * count)
    for (const tab of tabs) {
      for (const field of fields) {
        expect(
          field(`${nativeChatViewKey(tab.id, 'local', tab.entityId)}\0a`, () => 7).current
        ).toBe(7)
      }
    }
    // Retire the new cells as well; teardown visits only the two admitted views.
    await act(async () => useAppStore.setState({ unifiedTabsByWorktree: {} }))
    const teardown = policyVisits
    rendered.unmount()
    await act(async () => {})
    expect(policyVisits).toBe(teardown)
    console.log(JSON.stringify({ count, policyVisits, retiredCells, sourceVisits }))
    entrySpy.mockRestore()
    valueSpy.mockRestore()
    sortSpy.mockRestore()
  }
)
