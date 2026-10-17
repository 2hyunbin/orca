import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexStalePane } from '@/store/terminals/terminal-contracts'
import {
  answerAgentAccountSwitchPrompt,
  getAgentAccountSwitchPrompt,
  resetAgentAccountSwitchSessionsForTests
} from './agent-account-switch-sessions'
import {
  handleRunningCodexSessionsAfterSwitch,
  offerRestoredCodexSessions
} from './codex-account-switch-sessions'
import { markLiveCodexSessionsForRestart } from './codex-session-restart'

type StoreStub = {
  settings: Record<string, never>
  codexStalePaneByPtyId: Record<string, CodexStalePane>
  pendingPaneAccountRestarts: Record<string, string>
  ptyIdsByTabId: Record<string, string[]>
  terminalLayoutsByTabId: Record<string, never>
  queuePaneAccountRestarts: (ptyIds: string[], agent: string) => void
  keepCodexStalePanes: (ptyIds: string[]) => void
}

const store = vi.hoisted((): StoreStub => ({
  settings: {},
  codexStalePaneByPtyId: {},
  pendingPaneAccountRestarts: {},
  ptyIdsByTabId: {},
  terminalLayoutsByTabId: {},
  queuePaneAccountRestarts: vi.fn(),
  keepCodexStalePanes: vi.fn()
}))
const forgetStalePanes = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('./codex-session-restart', () => ({
  markLiveCodexSessionsForRestart: vi.fn(),
  resolveCodexSwitchAccountLabel: (accounts: { id: string; email: string }[], id: string | null) =>
    accounts.find((account) => account.id === id)?.email ?? 'System default'
}))

const STALE: CodexStalePane = {
  previousAccountLabel: 'account-a@example.com',
  nextAccountLabel: 'b'
}

/** A live stale pane with no layout leaf, bound in its own tab. */
function stalePane(ptyId: string): {
  ptyId: string
  worktreeId: string
  tabId: string
  leafId: null
} {
  store.ptyIdsByTabId[`tab-${ptyId}`] = [ptyId]
  store.codexStalePaneByPtyId[ptyId] = STALE
  return { ptyId, worktreeId: 'wt-1', tabId: `tab-${ptyId}`, leafId: null }
}

const listed = (): string[] | undefined =>
  getAgentAccountSwitchPrompt()?.sessions.map((entry) => entry.ptyId)

const ROSTER = [
  { id: 'acct-b', email: 'account-b@example.com' },
  { id: 'acct-c', email: 'account-c@example.com' }
]
const SWITCH = {
  owner: { kind: 'local' } as const,
  target: { runtime: 'host' } as const,
  before: { accounts: ROSTER, accountId: 'acct-b' },
  after: { accounts: ROSTER, accountId: 'acct-c' }
}

describe('Codex account switch questions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAgentAccountSwitchSessionsForTests()
    store.codexStalePaneByPtyId = {}
    store.pendingPaneAccountRestarts = {}
    store.ptyIdsByTabId = {}
    vi.stubGlobal('window', { api: { codexAccounts: { forgetStalePanes } } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('names the account each pane launched on, not the one just left', async () => {
    vi.mocked(markLiveCodexSessionsForRestart).mockResolvedValue([stalePane('pty-1')])

    expect(await handleRunningCodexSessionsAfterSwitch(SWITCH)).toBe('handled')

    expect(markLiveCodexSessionsForRestart).toHaveBeenCalledWith(
      expect.objectContaining({
        previousAccountLabel: 'account-b@example.com',
        nextAccountLabel: 'account-c@example.com',
        previousAccountId: 'acct-b',
        nextAccountId: 'acct-c'
      })
    )
    expect(getAgentAccountSwitchPrompt()).toMatchObject({
      agent: 'codex',
      previousAccountLabel: 'account-a@example.com',
      nextAccountLabel: 'account-c@example.com'
    })
  })

  it('keeps the host question open through a WSL switch, and answers both', async () => {
    vi.mocked(markLiveCodexSessionsForRestart).mockResolvedValueOnce([stalePane('wt1@@host')])
    await handleRunningCodexSessionsAfterSwitch(SWITCH)
    vi.mocked(markLiveCodexSessionsForRestart).mockResolvedValueOnce([stalePane('wt1@@wsl')])

    expect(
      await handleRunningCodexSessionsAfterSwitch({
        ...SWITCH,
        target: { runtime: 'wsl', wslDistro: 'Ubuntu' }
      })
    ).toBe('handled')

    expect(listed()).toEqual(['wt1@@host'])
    answerAgentAccountSwitchPrompt('restart')
    expect(listed()).toEqual(['wt1@@wsl'])
  })

  it("keeps a local question open when a server's switch asks about its own panes", async () => {
    vi.mocked(markLiveCodexSessionsForRestart).mockResolvedValueOnce([stalePane('wt1@@local')])
    await handleRunningCodexSessionsAfterSwitch(SWITCH)
    vi.mocked(markLiveCodexSessionsForRestart).mockResolvedValueOnce([])

    await handleRunningCodexSessionsAfterSwitch({
      ...SWITCH,
      owner: { kind: 'environment', environmentId: 'env-1' }
    })

    expect(listed()).toEqual(['wt1@@local'])
  })

  it('lets clearing every WSL distro replace a single distro question', async () => {
    vi.mocked(markLiveCodexSessionsForRestart).mockResolvedValueOnce([stalePane('wt1@@ubuntu')])
    await handleRunningCodexSessionsAfterSwitch({
      ...SWITCH,
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' }
    })
    vi.mocked(markLiveCodexSessionsForRestart).mockResolvedValueOnce([])

    await handleRunningCodexSessionsAfterSwitch({
      ...SWITCH,
      target: { runtime: 'wsl', wslDistro: null },
      clearsEveryWslDistro: true
    })

    expect(getAgentAccountSwitchPrompt()).toBeNull()
  })

  it("records Keep and forgets only this machine's launch records", async () => {
    vi.mocked(markLiveCodexSessionsForRestart).mockResolvedValue([
      stalePane('wt1@@local'),
      stalePane('remote:env-1@@term-1')
    ])
    await handleRunningCodexSessionsAfterSwitch(SWITCH)

    answerAgentAccountSwitchPrompt('keep')

    expect(store.keepCodexStalePanes).toHaveBeenCalledWith(['wt1@@local', 'remote:env-1@@term-1'])
    expect(forgetStalePanes).toHaveBeenCalledWith({ ptyIds: ['wt1@@local'] })
  })

  it('joins restored panes to their lane question and drops one switched back meanwhile', async () => {
    offerRestoredCodexSessions([
      { ...stalePane('pty-1'), laneKey: 'host' },
      { ...stalePane('pty-2'), laneKey: 'host' }
    ])
    vi.mocked(markLiveCodexSessionsForRestart).mockResolvedValueOnce([stalePane('pty-3')])
    await handleRunningCodexSessionsAfterSwitch(SWITCH)
    offerRestoredCodexSessions([{ ...stalePane('pty-1'), laneKey: 'host' }])
    // A switch back to its launch account drops the pane's record (markCodexStalePanes).
    delete store.codexStalePaneByPtyId['pty-1']

    expect(listed()).toEqual(['pty-3', 'pty-1'])
    answerAgentAccountSwitchPrompt('restart')
    expect(store.queuePaneAccountRestarts).toHaveBeenCalledWith(['pty-3'], 'codex')
  })

  it('asks nothing about a pane whose restart is already queued', async () => {
    vi.mocked(markLiveCodexSessionsForRestart).mockResolvedValue([stalePane('pty-1')])
    await handleRunningCodexSessionsAfterSwitch(SWITCH)
    store.pendingPaneAccountRestarts = { 'pty-1': 'codex' }

    answerAgentAccountSwitchPrompt('keep')

    expect(store.keepCodexStalePanes).not.toHaveBeenCalled()
  })

  it('leaves the account unnamed when restored panes sit on different ones', () => {
    stalePane('pty-1')
    stalePane('pty-2')
    store.codexStalePaneByPtyId['pty-2'] = { ...STALE, previousAccountLabel: 'other@example.com' }

    offerRestoredCodexSessions([
      { ptyId: 'pty-1', worktreeId: 'wt-1', tabId: 'tab-pty-1', leafId: null, laneKey: 'host' },
      { ptyId: 'pty-2', worktreeId: 'wt-1', tabId: 'tab-pty-2', leafId: null, laneKey: 'host' }
    ])

    expect(getAgentAccountSwitchPrompt()).toMatchObject({
      reason: 'restored',
      previousAccountLabel: null
    })
  })
})
