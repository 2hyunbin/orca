import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeAccountSwitchRunningSessions } from '../../../shared/claude-account-switch-settings'
import { findMovableClaudeSessions } from './claude-session-account-move'
import {
  answerClaudeAccountSwitchPrompt,
  getClaudeAccountSwitchPrompt,
  handleRunningClaudeSessionsAfterSwitch,
  resetClaudeAccountSwitchSessionsForTests
} from './claude-account-switch-sessions'

type SwitchSettings = { claudeAccountSwitchRunningSessions?: ClaudeAccountSwitchRunningSessions }

type StoreStub = {
  settings: SwitchSettings
  updateSettings: (updates: SwitchSettings) => Promise<void>
  queuePaneAccountRestarts: (
    ptyIds: string[],
    agent: string,
    options?: { replaceQueued?: boolean }
  ) => void
}

const store = vi.hoisted((): StoreStub => ({
  settings: {},
  updateSettings: vi.fn(async () => {}),
  queuePaneAccountRestarts: vi.fn()
}))
const toastSuccess = vi.hoisted(() => vi.fn())

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { success: toastSuccess } }))
vi.mock('./claude-session-account-move', () => ({ findMovableClaudeSessions: vi.fn() }))

const candidate = (n: number) => ({ ptyId: `pty-${n}`, tabId: `tab-${n}`, leafId: `leaf-${n}` })
const SWITCH = {
  owner: { kind: 'local' } as const,
  target: { runtime: 'host' } as const,
  previousAccountId: 'acct-a',
  previousAccountLabel: 'a@example.com',
  nextAccountLabel: 'b@example.com'
}
const REPLACE = { replaceQueued: true }

describe('handleRunningClaudeSessionsAfterSwitch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetClaudeAccountSwitchSessionsForTests()
    store.settings = {}
  })

  it('asks nothing when no Claude session runs on the outgoing account', async () => {
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([])

    expect(await handleRunningClaudeSessionsAfterSwitch(SWITCH)).toBe('none')
    expect(getClaudeAccountSwitchPrompt()).toBeNull()
    expect(findMovableClaudeSessions).toHaveBeenCalledWith(
      expect.objectContaining({ fromAccountId: 'acct-a' })
    )
  })

  it('drops restarts an earlier switch queued', async () => {
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([])

    await handleRunningClaudeSessionsAfterSwitch(SWITCH)

    expect(store.queuePaneAccountRestarts).toHaveBeenCalledWith([], 'claude', REPLACE)
  })

  it('restarts on the new account when the user picks Restart', async () => {
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([candidate(1), candidate(2)])
    expect(await handleRunningClaudeSessionsAfterSwitch(SWITCH)).toBe('prompted')
    expect(getClaudeAccountSwitchPrompt()?.ptyIds).toEqual(['pty-1', 'pty-2'])

    answerClaudeAccountSwitchPrompt('restart')

    expect(store.queuePaneAccountRestarts).toHaveBeenLastCalledWith(
      ['pty-1', 'pty-2'],
      'claude',
      REPLACE
    )
    expect(getClaudeAccountSwitchPrompt()).toBeNull()
    expect(store.updateSettings).not.toHaveBeenCalled()
  })

  it('leaves sessions alone when the user keeps them', async () => {
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([candidate(1)])
    await handleRunningClaudeSessionsAfterSwitch(SWITCH)

    answerClaudeAccountSwitchPrompt('keep')

    expect(store.queuePaneAccountRestarts).toHaveBeenCalledTimes(1)
    expect(getClaudeAccountSwitchPrompt()).toBeNull()
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
    expect(store.queuePaneAccountRestarts).toHaveBeenLastCalledWith(
      ['pty-1', 'pty-2'],
      'claude',
      REPLACE
    )
    expect(toastSuccess).toHaveBeenCalledWith('Restarting 2 Claude sessions on b@example.com')
  })

  it('keeps sessions without asking when the setting is Never restart', async () => {
    store.settings = { claudeAccountSwitchRunningSessions: 'keep' }
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([candidate(1)])

    expect(await handleRunningClaudeSessionsAfterSwitch(SWITCH)).toBe('kept')
    expect(getClaudeAccountSwitchPrompt()).toBeNull()
    expect(store.queuePaneAccountRestarts).toHaveBeenCalledTimes(1)
  })

  it('drops an earlier question once a newer switch lands', async () => {
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([candidate(1)])
    await handleRunningClaudeSessionsAfterSwitch(SWITCH)
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([])

    await handleRunningClaudeSessionsAfterSwitch(SWITCH)

    expect(getClaudeAccountSwitchPrompt()).toBeNull()
  })
})
