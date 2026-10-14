// @vitest-environment happy-dom
import type { AiVaultSurfaceSwitchOperation } from '@/lib/ai-vault-surface-switch-operation'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSortableTabContextMenu } from './use-sortable-tab-context-menu'
import { TabSessionSurfaceSwitchMenuItems } from './TabSessionSurfaceSwitchMenuItems'
import { TerminalPaneResumeInChatButton } from '../terminal-pane/TerminalPaneResumeInChatButton'
import { runTabSessionSurfaceSwitch } from './tab-session-surface-switch-run'
import type { TabSessionSelectedSource } from './tab-session-selected-source'
import type {
  AiVaultSessionLaunchContext,
  AiVaultResolveSessionResult
} from '../../../../shared/ai-vault-selected-session'

const mocks = vi.hoisted(() => ({
  openTabs: ['tab-1'],
  subscribers: new Set<() => void>(),
  resolve: vi.fn(),
  cancel: vi.fn(async () => {}),
  launch: vi.fn<
    (
      row: AiVaultSessionLaunchContext,
      workspace: string,
      operation: AiVaultSurfaceSwitchOperation
    ) => Promise<void>
  >(async () => {}),
  activate: vi.fn(async () => true),
  error: vi.fn(),
  complete: vi.fn()
}))
const SUBJECT: TabSessionSelectedSource = {
  kind: 'cli',
  agent: 'claude',
  providerSessionId: 'provider-1',
  paneKey: 'tab-1:leaf-1',
  workspaceId: 'wt-1',
  executionHostId: 'local',
  legacyListRequest: { executionHostScope: 'local', scopePaths: ['/repo'], sessionLimit: 250 }
}
const ROW: AiVaultSessionLaunchContext = {
  agent: 'claude',
  sessionId: 'provider-1',
  title: 'Task',
  executionHostId: 'local',
  filePath: '/home/.claude/projects/repo/provider-1.jsonl',
  cwd: '/repo',
  codexHome: null,
  branch: null,
  messageCount: 2,
  previewMessages: []
}
function state() {
  return {
    settings: null,
    tabsByWorktree: { 'wt-1': mocks.openTabs.map((id) => ({ id })) },
    unifiedTabsByWorktree: {},
    agentStatusByPaneKey: {
      'tab-1:leaf-1': { agentType: 'claude', providerSession: { id: 'provider-1' } }
    }
  }
}
function store() {
  return {
    useAppStore: Object.assign(
      (selector: (value: ReturnType<typeof state>) => unknown) => selector(state()),
      {
        getState: state,
        subscribe: (listener: () => void) => {
          mocks.subscribers.add(listener)
          return () => mocks.subscribers.delete(listener)
        }
      }
    )
  }
}
vi.mock('@/store', () => store())
vi.mock('../../store', () => store())
vi.mock('sonner', () => ({ toast: { error: mocks.error } }))
vi.mock('@/lib/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: mocks.activate
}))
vi.mock('./tab-session-selected-source', () => ({
  resolveTabSessionSelectedSource: () => SUBJECT,
  resolveTabSessionSwitch: () => ({ action: 'resume-in-new-chat', worktreeId: 'wt-1' })
}))
vi.mock('../right-sidebar/ai-vault-session-launch-actions', () => ({
  useAiVaultSessionLaunchActions: () => ({
    handleResumeInNewChat: mocks.launch,
    handleResumeInNewCli: mocks.launch
  })
}))
vi.mock('../right-sidebar/ai-vault-session-resume-in-chat-launch', () => ({
  resumeAiVaultSessionInNewChat: mocks.launch
}))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.openTabs = ['tab-1']
  mocks.resolve.mockResolvedValue({ status: 'ready', session: ROW })
  Object.assign(window, {
    api: { aiVault: { resolveSession: mocks.resolve, cancelResolveSession: mocks.cancel } }
  })
})
afterEach(async () => {
  await act(async () => {
    mocks.openTabs = []
    mocks.subscribers.forEach((listener) => listener())
  })
  cleanup()
  vi.restoreAllMocks()
})
function ControlledMenu() {
  const menu = useSortableTabContextMenu()
  return (
    <>
      <button onClick={() => menu.onOpenChange(false)}>Dismiss</button>
      <button onClick={() => menu.onOpenChange(true)}>Reopen</button>
      <DropdownMenu open={menu.open} onOpenChange={menu.onOpenChange} modal={false}>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <TabSessionSurfaceSwitchMenuItems
            key={menu.openingId}
            tab={{ id: 'tab-1', worktreeId: 'wt-1' }}
            leadingSeparator
            onComplete={() => {
              mocks.complete()
              menu.onComplete()
            }}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
function mount() {
  const view = render(
    <TooltipProvider>
      <ControlledMenu />
      <TerminalPaneResumeInChatButton tabId="tab-1" worktreeId="wt-1" paneKey="tab-1:leaf-1" />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
  return view
}
async function clickMenu() {
  await act(async () =>
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resume in New Native Chat' }))
  )
}
it('offers immediately, shows shared pending, then launches the selected host answer without listing', async () => {
  let finish: (value: AiVaultResolveSessionResult) => void = () => {}
  mocks.resolve.mockReturnValue(
    new Promise<AiVaultResolveSessionResult>((resolve) => {
      finish = resolve
    })
  )
  mount()
  expect(mocks.resolve).not.toHaveBeenCalled()
  await clickMenu()
  expect(
    screen.getByRole('menuitem', { name: 'Loading conversation…' }).getAttribute('aria-disabled')
  ).toBe('true')
  expect(
    screen.getByRole('button', { name: 'Loading conversation…' }).hasAttribute('disabled')
  ).toBe(true)
  expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      executionHostId: 'local',
      source: {
        kind: 'cli',
        agent: 'claude',
        providerSessionId: 'provider-1',
        paneKey: 'tab-1:leaf-1',
        workspaceId: 'wt-1'
      }
    })
  )
  await act(async () => finish({ status: 'ready', session: ROW }))
  expect(mocks.launch).toHaveBeenCalledWith(
    ROW,
    'wt-1',
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  )
  expect(mocks.complete).toHaveBeenCalledOnce()
})
it('refuses an existing owner from New menu while preserving header activation', async () => {
  const owned = { ...ROW, structuredSession: { sessionId: 'chat-1', workspaceId: 'elsewhere' } }
  mocks.resolve.mockResolvedValue({ status: 'ready', session: owned })
  mount()
  await clickMenu()
  expect(mocks.activate).not.toHaveBeenCalled()
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(mocks.error).toHaveBeenCalledWith('Another chat is already holding this conversation.')
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Resume in New Native Chat' }))
  )
  expect(mocks.activate).toHaveBeenCalledExactlyOnceWith(owned)
})
it('detaches a closed source immediately and lets a successor run before the old reply', async () => {
  let finish: (value: AiVaultResolveSessionResult) => void = () => {}
  mocks.resolve.mockReturnValueOnce(
    new Promise<AiVaultResolveSessionResult>((resolve) => {
      finish = resolve
    })
  )
  mount()
  await clickMenu()
  const token = mocks.resolve.mock.calls[0]?.[0].requestToken
  await act(async () => {
    mocks.openTabs = ['tab-2']
    mocks.subscribers.forEach((listener) => listener())
  })
  expect(mocks.cancel).toHaveBeenCalledWith({ requestToken: token })
  await act(async () =>
    runTabSessionSurfaceSwitch({
      subject: SUBJECT,
      sourceTab: { id: 'tab-2', worktreeId: 'wt-1' },
      launch: mocks.launch
    })
  )
  expect(mocks.resolve).toHaveBeenCalledTimes(2)
  expect(mocks.launch).toHaveBeenCalledOnce()
  await act(async () => finish({ status: 'ready', session: ROW }))
  expect(mocks.launch).toHaveBeenCalledOnce()
  expect(mocks.error).not.toHaveBeenCalled()
})
it('reports unreadable saved history honestly and does not reuse the unsaved remedy', async () => {
  mocks.resolve.mockRejectedValue(new Error('EACCES: conversation history'))
  mount()
  await clickMenu()
  expect(mocks.error).toHaveBeenCalledWith('Could not resume this session in a new chat.', {
    description: 'EACCES: conversation history'
  })
  expect(mocks.launch).not.toHaveBeenCalled()
})

it('an abandoned preparation stays abandoned when the same source appears again', async () => {
  let operation: AiVaultSurfaceSwitchOperation | undefined
  let finish = () => {}
  mocks.launch.mockImplementationOnce(async (_row, _workspace, observer) => {
    operation = observer
    await new Promise<void>((resolve) => {
      finish = resolve
    })
  })
  mount()
  await clickMenu()
  expect(operation?.isSourceOpen()).toBe(true)
  await act(async () => {
    mocks.openTabs = []
    mocks.subscribers.forEach((listener) => listener())
  })
  mocks.openTabs = ['tab-1']
  expect(operation?.isSourceOpen()).toBe(false)
  expect(operation?.signal.aborted).toBe(true)
  await act(async () => finish())
})

it('old completion cannot dismiss a newer opening retained across the closing animation', async () => {
  const computed = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = computed(element, pseudo)
    if (element.getAttribute('data-slot') === 'dropdown-menu-content') {
      return new Proxy(style, {
        get(target, key) {
          if (key === 'animationName') {
            return element.getAttribute('data-state') === 'open' ? 'enter' : 'exit'
          }
          if (key === 'getPropertyValue') {
            return target.getPropertyValue.bind(target)
          }
          return typeof key === 'string'
            ? target.getPropertyValue(key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`))
            : undefined
        }
      })
    }
    return style
  })
  let finish: (value: AiVaultResolveSessionResult) => void = () => {}
  mocks.resolve.mockReturnValueOnce(
    new Promise<AiVaultResolveSessionResult>((resolve) => {
      finish = resolve
    })
  )
  mount()
  await clickMenu()
  const oldItem = screen.getByRole('menuitem', { name: 'Loading conversation…' })
  const content = oldItem.closest('[data-slot="dropdown-menu-content"]')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })))
  expect(oldItem.isConnected).toBe(true)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reopen' })))
  const newItem = screen.getByRole('menuitem', { name: 'Loading conversation…' })
  expect(newItem).not.toBe(oldItem)
  expect(newItem.closest('[data-slot="dropdown-menu-content"]')).toBe(content)
  await act(async () => finish({ status: 'ready', session: ROW }))
  expect(mocks.launch).toHaveBeenCalledOnce()
  expect(content?.getAttribute('data-state')).toBe('open')
  expect(screen.getByRole('menuitem', { name: 'Resume in New Native Chat' })).toBeTruthy()
  vi.restoreAllMocks()
})
