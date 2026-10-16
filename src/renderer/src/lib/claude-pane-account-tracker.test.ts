import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { getDefaultSettings } from '../../../shared/constants'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  getSelectedClaudeAccountIdForLane,
  installClaudePaneAccountTracker,
  mayBeOnClaudeAccount,
  recordClaudePaneAccount,
  resetClaudePaneAccountTrackerForTests
} from './claude-pane-account-tracker'

const LEAF = '0195f2ce-1111-4000-8000-000000000001'
const PANE_KEY = makePaneKey('tab-1', LEAF)

function selectHostAccount(accountId: string | null): void {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/home/dev'),
      activeClaudeManagedAccountId: accountId,
      activeClaudeManagedAccountIdsByRuntime: { host: accountId, wsl: {} }
    }
  })
}

function seedPane(): void {
  useAppStore.setState({
    tabsByWorktree: {
      wt1: [
        {
          id: 'tab-1',
          ptyId: 'pty-1',
          worktreeId: 'wt1',
          title: 'claude',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: 'pty-1' }
      }
    },
    agentStatusByPaneKey: {}
  })
}

function startClaudeSession(sessionId: string): void {
  const entry: AgentStatusEntry = {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    state: 'working',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    agentType: 'claude',
    providerSession: { key: 'session_id', id: sessionId }
  }
  useAppStore.setState({ agentStatusByPaneKey: { [PANE_KEY]: entry } })
}

describe('claude pane account tracker', () => {
  let uninstall: () => void = () => {}

  beforeEach(() => {
    resetClaudePaneAccountTrackerForTests()
    useAppStore.setState({ settings: null })
    seedPane()
  })

  afterEach(() => {
    uninstall()
  })

  it('reads the lane selection from settings', () => {
    selectHostAccount('acct-a')
    const settings = useAppStore.getState().settings
    expect(getSelectedClaudeAccountIdForLane(settings, 'host')).toBe('acct-a')
    expect(getSelectedClaudeAccountIdForLane(settings, 'ssh-connection')).toBeUndefined()
  })

  it('treats a session already running at startup as unknown', () => {
    startClaudeSession('s1')
    selectHostAccount('acct-a')
    uninstall = installClaudePaneAccountTracker()

    expect(mayBeOnClaudeAccount(PANE_KEY, 'acct-a')).toBe(true)
    expect(mayBeOnClaudeAccount(PANE_KEY, 'acct-b')).toBe(true)
  })

  it('attributes a session started later to the account selected then', () => {
    selectHostAccount('acct-a')
    uninstall = installClaudePaneAccountTracker()

    startClaudeSession('s1')
    selectHostAccount('acct-b')

    expect(mayBeOnClaudeAccount(PANE_KEY, 'acct-a')).toBe(true)
    expect(mayBeOnClaudeAccount(PANE_KEY, 'acct-b')).toBe(false)
  })

  it('forgets the account when the pane shows a different session', () => {
    selectHostAccount('acct-a')
    uninstall = installClaudePaneAccountTracker()
    startClaudeSession('s1')

    startClaudeSession('s2')

    expect(mayBeOnClaudeAccount(PANE_KEY, 'acct-b')).toBe(true)
  })

  it('takes the account Orca restarted the session on', () => {
    selectHostAccount('acct-a')
    uninstall = installClaudePaneAccountTracker()
    startClaudeSession('s1')

    recordClaudePaneAccount(PANE_KEY, 'acct-b')

    expect(mayBeOnClaudeAccount(PANE_KEY, 'acct-a')).toBe(false)
    expect(mayBeOnClaudeAccount(PANE_KEY, 'acct-b')).toBe(true)
  })
})
