// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { resetAiVaultForcedRescanThrottleForTest } from '../right-sidebar/ai-vault-session-refresh'
import { cacheAiVaultSessionList } from '../right-sidebar/ai-vault-session-list-request'
import { TabSessionSurfaceSwitchMenuItems } from './TabSessionSurfaceSwitchMenuItems'

const mocks = vi.hoisted(() => {
  const state: {
    subject: Record<string, unknown> | null
    move: { action: string; worktreeId: string } | null
    launchActionArgs: unknown[]
    tabOpen: boolean
  } = { subject: null, move: null, launchActionArgs: [], tabOpen: true }
  return {
    ...state,
    handleResumeInNewChat: vi.fn(async () => {}),
    handleResumeInNewCli: vi.fn(async () => {}),
    resolveSwitch: vi.fn(),
    listSessions: vi.fn(),
    cancelListSessions: vi.fn(async () => {}),
    activateChat: vi.fn(async () => true),
    toastError: vi.fn()
  }
})

// The component and the click runner import the store by different specifiers.
const storeMock = vi.hoisted(() => () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({ settings: null }),
    {
      getState: () => ({
        tabsByWorktree: {},
        unifiedTabsByWorktree: { 'wt-1': mocks.tabOpen ? [{ id: 'tab-1' }] : [] }
      })
    }
  )
}))
vi.mock('../../store', storeMock)
vi.mock('@/store', storeMock)

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

vi.mock('@/lib/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: mocks.activateChat
}))

vi.mock('./tab-session-history-switch', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveTabSessionHistorySubject: () => mocks.subject,
  resolveTabSessionSwitch: mocks.resolveSwitch
}))

vi.mock('../right-sidebar/ai-vault-session-launch-actions', () => ({
  useAiVaultSessionLaunchActions: (args: unknown) => {
    mocks.launchActionArgs.push(args)
    return {
      handleResumeInNewChat: mocks.handleResumeInNewChat,
      handleResumeInNewCli: mocks.handleResumeInNewCli
    }
  }
}))

const CHAT_ROW: AiVaultSession = {
  id: 'row-1',
  executionHostId: 'local',
  agent: 'claude',
  sessionId: 'claude-session-1',
  title: 'Fix the build',
  cwd: '/repo/wt',
  branch: null,
  model: null,
  filePath: '/home/.claude/projects/repo/claude-session-1.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-10-08T00:00:00.000Z',
  messageCount: 2,
  totalTokens: 10,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: '',
  subagent: null,
  structuredSession: { sessionId: 'orca-chat-1', workspaceId: 'wt-1' }
}

const PANEL_REQUEST = {
  scopePaths: ['/repo/wt'],
  executionHostScope: 'local',
  sessionLimit: 250
} as const

const CHAT_SUBJECT = {
  kind: 'chat',
  agent: 'claude',
  sessionId: 'orca-chat-1',
  workspaceId: 'wt-1',
  request: PANEL_REQUEST
}

const CLI_SUBJECT = {
  kind: 'cli',
  agent: 'claude',
  providerSessionId: 'claude-session-1',
  workspaceId: 'wt-1',
  request: PANEL_REQUEST
}

function listResult(sessions: AiVaultSession[]) {
  return { sessions, issues: [], scannedAt: 'now' }
}

beforeEach(() => {
  resetAiVaultForcedRescanThrottleForTest()
  mocks.subject = null
  mocks.move = null
  mocks.launchActionArgs = []
  mocks.tabOpen = true
  mocks.activateChat.mockClear()
  mocks.toastError.mockReset()
  mocks.handleResumeInNewChat.mockReset()
  mocks.handleResumeInNewCli.mockReset()
  mocks.resolveSwitch.mockReset()
  mocks.resolveSwitch.mockImplementation(() => mocks.move)
  mocks.listSessions.mockReset()
  mocks.listSessions.mockResolvedValue({
    sessions: [CHAT_ROW],
    issues: [],
    scannedAt: 'now'
  })
  Object.assign(window, {
    api: {
      aiVault: {
        listSessions: mocks.listSessions,
        cancelListSessions: mocks.cancelListSessions
      }
    }
  })
})

afterEach(cleanup)

function renderItemsNow(structuredSessionId?: string): void {
  render(
    <TooltipProvider>
      <DropdownMenu open>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <TabSessionSurfaceSwitchMenuItems
            tab={{ id: 'tab-1', worktreeId: 'wt-1' }}
            nativeChat={
              structuredSessionId ? { sessionId: structuredSessionId, agent: 'claude' } : undefined
            }
            leadingSeparator
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
}

async function renderItems(structuredSessionId?: string): Promise<void> {
  renderItemsNow(structuredSessionId)
  await act(async () => {})
}

async function clickItem(name: string): Promise<void> {
  fireEvent.click(screen.getByRole('menuitem', { name }))
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
}

describe('TabSessionSurfaceSwitchMenuItems', () => {
  it('looks nothing up and shows nothing for a tab without a history session', async () => {
    await renderItems()
    expect(mocks.listSessions).not.toHaveBeenCalled()
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('offers Resume in New CLI on a chat tab at once, without waiting on Session History', () => {
    mocks.subject = CHAT_SUBJECT
    renderItemsNow('orca-chat-1')

    expect(screen.getByRole('separator')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Resume in New CLI' })).toBeTruthy()
    expect(screen.queryByText('Resume in New Native Chat')).toBeNull()
    expect(mocks.listSessions).not.toHaveBeenCalled()
  })

  it('offers Resume in New Native Chat on a CLI tab at once', () => {
    mocks.subject = CLI_SUBJECT
    renderItemsNow()

    expect(screen.getByRole('menuitem', { name: 'Resume in New Native Chat' })).toBeTruthy()
    expect(screen.queryByText('Resume in New CLI')).toBeNull()
    expect(mocks.listSessions).not.toHaveBeenCalled()
  })

  it('looks the row up on click and runs the Session History "Resume in New CLI" handler', async () => {
    mocks.subject = CHAT_SUBJECT
    mocks.move = { action: 'resume-in-new-cli', worktreeId: 'wt-1' }
    await renderItems('orca-chat-1')
    await clickItem('Resume in New CLI')

    expect(mocks.listSessions).toHaveBeenCalledTimes(1)
    expect(mocks.resolveSwitch).toHaveBeenCalledWith(expect.anything(), CHAT_ROW, CHAT_SUBJECT)
    expect(mocks.handleResumeInNewCli).toHaveBeenCalledWith(CHAT_ROW, 'wt-1')
    expect(mocks.launchActionArgs.at(-1)).toMatchObject({
      activeWorktree: null,
      activeWorktreeId: 'wt-1'
    })
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('runs the Session History "Resume in New Native Chat" handler for a CLI tab', async () => {
    const cliRow = { ...CHAT_ROW, structuredSession: undefined }
    mocks.listSessions.mockResolvedValue(listResult([cliRow]))
    mocks.subject = CLI_SUBJECT
    mocks.move = { action: 'resume-in-new-chat', worktreeId: 'wt-1' }
    await renderItems()
    await clickItem('Resume in New Native Chat')

    expect(mocks.handleResumeInNewChat).toHaveBeenCalledWith(cliRow, 'wt-1')
  })

  it('says so when the Session History gate withholds the move', async () => {
    mocks.subject = CHAT_SUBJECT
    await renderItems('orca-chat-1')
    await clickItem('Resume in New CLI')

    expect(mocks.handleResumeInNewCli).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('This session cannot be opened in the CLI.')
  })

  it('acts on the fresh answer, never a stale cached row', async () => {
    // The cached row predates a chat taking the conversation; only the fresh reply knows.
    const cliRow = { ...CHAT_ROW, structuredSession: undefined }
    cacheAiVaultSessionList(PANEL_REQUEST, listResult([cliRow]), { replaceHostEntries: false })
    mocks.listSessions.mockResolvedValue(listResult([CHAT_ROW]))
    mocks.subject = CLI_SUBJECT
    mocks.move = { action: 'resume-in-new-chat', worktreeId: 'wt-1' }
    await renderItems()
    await clickItem('Resume in New Native Chat')

    expect(mocks.handleResumeInNewChat).not.toHaveBeenCalled()
    expect(mocks.activateChat).toHaveBeenCalledWith(CHAT_ROW)
  })

  it('runs one move per conversation while a click is still looking it up', async () => {
    let settle: (result: ReturnType<typeof listResult>) => void = () => {}
    mocks.listSessions.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve
      })
    )
    mocks.subject = CHAT_SUBJECT
    mocks.move = { action: 'resume-in-new-cli', worktreeId: 'wt-1' }
    await renderItems('orca-chat-1')
    const item = screen.getByRole('menuitem', { name: 'Resume in New CLI' })
    await act(async () => {
      fireEvent.click(item)
      fireEvent.click(item)
    })
    await act(async () => settle(listResult([CHAT_ROW])))

    expect(mocks.listSessions).toHaveBeenCalledTimes(1)
    expect(mocks.handleResumeInNewCli).toHaveBeenCalledTimes(1)
  })

  it('starts no second move from a reopened menu while the first is still looking up', async () => {
    let settle: (result: ReturnType<typeof listResult>) => void = () => {}
    mocks.listSessions.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve
      })
    )
    mocks.subject = CHAT_SUBJECT
    mocks.move = { action: 'resume-in-new-cli', worktreeId: 'wt-1' }
    await renderItems('orca-chat-1')
    await clickItem('Resume in New CLI')
    cleanup()
    await renderItems('orca-chat-1')
    await clickItem('Resume in New CLI')
    await act(async () => settle(listResult([CHAT_ROW])))

    expect(mocks.listSessions).toHaveBeenCalledTimes(1)
    expect(mocks.handleResumeInNewCli).toHaveBeenCalledTimes(1)
    // Once it settles, the next click runs again.
    await clickItem('Resume in New CLI')
    expect(mocks.handleResumeInNewCli).toHaveBeenCalledTimes(2)
  })

  it('abandons the click silently once the tab closed during the lookup', async () => {
    mocks.listSessions.mockImplementation(async () => {
      mocks.tabOpen = false
      return listResult([CHAT_ROW])
    })
    mocks.subject = CHAT_SUBJECT
    mocks.move = { action: 'resume-in-new-cli', worktreeId: 'wt-1' }
    await renderItems('orca-chat-1')
    await clickItem('Resume in New CLI')

    expect(mocks.handleResumeInNewCli).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('reports a failed lookup as a failure to open the CLI', async () => {
    mocks.listSessions.mockRejectedValue(new Error('scanner crashed'))
    mocks.subject = CHAT_SUBJECT
    mocks.move = { action: 'resume-in-new-cli', worktreeId: 'wt-1' }
    await renderItems('orca-chat-1')
    await clickItem('Resume in New CLI')

    expect(mocks.handleResumeInNewCli).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('Could not resume this session in a new CLI.', {
      description: 'scanner crashed'
    })
  })
})
