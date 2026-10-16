import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mayBeOnClaudeAccount, recordClaudePaneAccount } from './claude-pane-account-tracker'
import {
  cancelPendingClaudeSessionMoves,
  findMovableClaudeSessions,
  moveClaudeSessionsToSelectedAccount
} from './claude-session-account-move'
import type { ClaudeAccountSwitchRunningSessions } from '../../../shared/claude-account-switch-settings'
import {
  answerClaudeAccountSwitchPrompt,
  getClaudeAccountSwitchPrompt,
  handleRunningClaudeSessionsAfterSwitch,
  resetClaudeAccountSwitchSessionsForTests
} from './claude-account-switch-sessions'

type StoreStub = {
  settings: { claudeAccountSwitchRunningSessions?: ClaudeAccountSwitchRunningSessions }
  updateSettings: (updates: object) => Promise<void>
}

const store = vi.hoisted((): StoreStub => ({ settings: {}, updateSettings: vi.fn(async () => {}) }))
const toastSuccess = vi.hoisted(() => vi.fn())

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { success: toastSuccess } }))
vi.mock('./claude-session-account-move', () => ({
  cancelPendingClaudeSessionMoves: vi.fn(),
  findMovableClaudeSessions: vi.fn(),
  moveClaudeSessionsToSelectedAccount: vi.fn()
}))
vi.mock('./claude-pane-account-tracker', () => ({
  mayBeOnClaudeAccount: vi.fn(() => true),
  recordClaudePaneAccount: vi.fn()
}))

const LEAF = (n: number): string => `0195f2ce-1111-4000-8000-00000000000${n}`
const candidate = (n: number) => ({ ptyId: `pty-${n}`, tabId: `tab-${n}`, leafId: LEAF(n) })
const SWITCH = {
  owner: { kind: 'local' } as const,
  target: { runtime: 'host' } as const,
  previousAccountId: 'acct-a',
  previousAccountLabel: 'a@example.com',
  nextAccountId: 'acct-b',
  nextAccountLabel: 'b@example.com'
}

describe('handleRunningClaudeSessionsAfterSwitch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetClaudeAccountSwitchSessionsForTests()
    store.settings = {}
    vi.mocked(mayBeOnClaudeAccount).mockReturnValue(true)
  })

  it('asks nothing when no Claude session is running', async () => {
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([])

    expect(await handleRunningClaudeSessionsAfterSwitch(SWITCH)).toBe('none')
    expect(getClaudeAccountSwitchPrompt()).toBeNull()
    expect(cancelPendingClaudeSessionMoves).toHaveBeenCalled()
  })

  it('counts only sessions that may be on the outgoing account', async () => {
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([candidate(1), candidate(2)])
    vi.mocked(mayBeOnClaudeAccount).mockImplementation((paneKey) => paneKey.startsWith('tab-1:'))

    expect(await handleRunningClaudeSessionsAfterSwitch(SWITCH)).toBe('prompted')
    expect(getClaudeAccountSwitchPrompt()?.candidates).toEqual([candidate(1)])
    expect(mayBeOnClaudeAccount).toHaveBeenCalledWith(`tab-2:${LEAF(2)}`, 'acct-a')
  })

  it('asks nothing when every running session is already off the outgoing account', async () => {
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([candidate(1)])
    vi.mocked(mayBeOnClaudeAccount).mockReturnValue(false)

    expect(await handleRunningClaudeSessionsAfterSwitch(SWITCH)).toBe('none')
    expect(getClaudeAccountSwitchPrompt()).toBeNull()
  })

  it('restarts on the new account when the user picks Restart', async () => {
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([candidate(1)])
    await handleRunningClaudeSessionsAfterSwitch(SWITCH)

    answerClaudeAccountSwitchPrompt('restart')

    expect(moveClaudeSessionsToSelectedAccount).toHaveBeenCalledWith([candidate(1)], 'acct-b')
    expect(getClaudeAccountSwitchPrompt()).toBeNull()
    expect(store.updateSettings).not.toHaveBeenCalled()
  })

  it('pins the outgoing account when the user keeps sessions as they are', async () => {
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([candidate(1)])
    await handleRunningClaudeSessionsAfterSwitch(SWITCH)

    answerClaudeAccountSwitchPrompt('keep')

    expect(moveClaudeSessionsToSelectedAccount).not.toHaveBeenCalled()
    expect(recordClaudePaneAccount).toHaveBeenCalledWith(`tab-1:${LEAF(1)}`, 'acct-a')
  })

  it.each(['restart', 'keep'] as const)('remembers %s when asked to', async (answer) => {
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([candidate(1)])
    await handleRunningClaudeSessionsAfterSwitch(SWITCH)

    answerClaudeAccountSwitchPrompt(answer, { remember: true })

    expect(store.updateSettings).toHaveBeenCalledWith({
      claudeAccountSwitchRunningSessions: answer
    })
  })

  it('restarts without asking when the setting is Always restart', async () => {
    store.settings = { claudeAccountSwitchRunningSessions: 'restart' }
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([candidate(1), candidate(2)])

    expect(await handleRunningClaudeSessionsAfterSwitch(SWITCH)).toBe('restarted')
    expect(getClaudeAccountSwitchPrompt()).toBeNull()
    expect(moveClaudeSessionsToSelectedAccount).toHaveBeenCalledWith(
      [candidate(1), candidate(2)],
      'acct-b'
    )
    expect(toastSuccess).toHaveBeenCalledWith('Restarting 2 Claude sessions on b@example.com')
  })

  it('keeps sessions without asking when the setting is Never restart', async () => {
    store.settings = { claudeAccountSwitchRunningSessions: 'keep' }
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([candidate(1)])

    expect(await handleRunningClaudeSessionsAfterSwitch(SWITCH)).toBe('kept')
    expect(getClaudeAccountSwitchPrompt()).toBeNull()
    expect(moveClaudeSessionsToSelectedAccount).not.toHaveBeenCalled()
    expect(recordClaudePaneAccount).toHaveBeenCalledWith(`tab-1:${LEAF(1)}`, 'acct-a')
  })

  it('drops an earlier question once a newer switch lands', async () => {
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([candidate(1)])
    await handleRunningClaudeSessionsAfterSwitch(SWITCH)
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([])

    await handleRunningClaudeSessionsAfterSwitch(SWITCH)

    expect(getClaudeAccountSwitchPrompt()).toBeNull()
  })
})
