import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeAccountSwitchRunningSessions } from '../../../shared/claude-account-switch-settings'
import {
  findMovableClaudeSessions,
  findQueuedClaudeRestartsOnAccount
} from './claude-session-account-move'
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
  queuePaneAccountRestarts: (ptyIds: string[], agent: string) => void
  consumePendingPaneAccountRestart: (ptyId: string) => void
}

const store = vi.hoisted((): StoreStub => ({
  settings: {},
  updateSettings: vi.fn(async () => {}),
  queuePaneAccountRestarts: vi.fn(),
  consumePendingPaneAccountRestart: vi.fn()
}))
const toastSuccess = vi.hoisted(() => vi.fn())

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { success: toastSuccess } }))
vi.mock('./claude-session-account-move', () => ({
  findMovableClaudeSessions: vi.fn(),
  findQueuedClaudeRestartsOnAccount: vi.fn(() => [])
}))

const candidate = (n: number) => ({ ptyId: `pty-${n}`, tabId: `tab-${n}`, leafId: `leaf-${n}` })
const SWITCH = {
  owner: { kind: 'local' } as const,
  target: { runtime: 'host' } as const,
  previousAccountId: 'acct-a',
  nextAccountId: 'acct-b',
  previousAccountLabel: 'a@example.com',
  nextAccountLabel: 'b@example.com'
}

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

  it('keeps earlier queued restarts except those already on the new account', async () => {
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([])
    vi.mocked(findQueuedClaudeRestartsOnAccount).mockReturnValueOnce(['pty-home'])

    await handleRunningClaudeSessionsAfterSwitch(SWITCH)

    expect(findQueuedClaudeRestartsOnAccount).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-b' })
    )
    expect(store.consumePendingPaneAccountRestart).toHaveBeenCalledTimes(1)
    expect(store.consumePendingPaneAccountRestart).toHaveBeenCalledWith('pty-home')
    expect(store.queuePaneAccountRestarts).not.toHaveBeenCalled()
  })

  it('leaves local questions and queued restarts alone on a server account switch', async () => {
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([candidate(1)])
    await handleRunningClaudeSessionsAfterSwitch(SWITCH)

    expect(
      await handleRunningClaudeSessionsAfterSwitch({
        ...SWITCH,
        owner: { kind: 'environment', environmentId: 'env-1' }
      })
    ).toBe('none')

    expect(getClaudeAccountSwitchPrompt()?.ptyIds).toEqual(['pty-1'])
    expect(findQueuedClaudeRestartsOnAccount).toHaveBeenCalledTimes(1)
  })

  it('restarts on the new account when the user picks Restart', async () => {
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([candidate(1), candidate(2)])
    expect(await handleRunningClaudeSessionsAfterSwitch(SWITCH)).toBe('prompted')
    expect(getClaudeAccountSwitchPrompt()?.ptyIds).toEqual(['pty-1', 'pty-2'])

    answerClaudeAccountSwitchPrompt('restart')

    expect(store.queuePaneAccountRestarts).toHaveBeenLastCalledWith(['pty-1', 'pty-2'], 'claude')
    expect(getClaudeAccountSwitchPrompt()).toBeNull()
    expect(store.updateSettings).not.toHaveBeenCalled()
  })

  it('leaves sessions alone when the user keeps them', async () => {
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([candidate(1)])
    await handleRunningClaudeSessionsAfterSwitch(SWITCH)

    answerClaudeAccountSwitchPrompt('keep')

    expect(store.queuePaneAccountRestarts).not.toHaveBeenCalled()
    expect(getClaudeAccountSwitchPrompt()).toBeNull()
  })

  it.each(['restart', 'keep'] as const)(
    'turns on automatic restarts on %s when told not to ask again',
    async (answer) => {
      vi.mocked(findMovableClaudeSessions).mockResolvedValue([candidate(1)])
      await handleRunningClaudeSessionsAfterSwitch(SWITCH)

      answerClaudeAccountSwitchPrompt(answer, { dontAskAgain: true })

      expect(store.updateSettings).toHaveBeenCalledWith({
        claudeAccountSwitchRunningSessions: 'restart'
      })
    }
  )

  it('restarts without asking when the setting is Always restart', async () => {
    store.settings = { claudeAccountSwitchRunningSessions: 'restart' }
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([candidate(1), candidate(2)])

    expect(await handleRunningClaudeSessionsAfterSwitch(SWITCH)).toBe('restarted')
    expect(getClaudeAccountSwitchPrompt()).toBeNull()
    expect(store.queuePaneAccountRestarts).toHaveBeenLastCalledWith(['pty-1', 'pty-2'], 'claude')
    expect(toastSuccess).toHaveBeenCalledWith('Restarting 2 Claude sessions on b@example.com')
  })

  it('keeps sessions without asking when the setting is Never restart', async () => {
    store.settings = { claudeAccountSwitchRunningSessions: 'keep' }
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([candidate(1)])

    expect(await handleRunningClaudeSessionsAfterSwitch(SWITCH)).toBe('kept')
    expect(getClaudeAccountSwitchPrompt()).toBeNull()
    expect(store.queuePaneAccountRestarts).not.toHaveBeenCalled()
  })

  it('drops an earlier question once a newer switch lands', async () => {
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([candidate(1)])
    await handleRunningClaudeSessionsAfterSwitch(SWITCH)
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([])

    await handleRunningClaudeSessionsAfterSwitch(SWITCH)

    expect(getClaudeAccountSwitchPrompt()).toBeNull()
  })
})
