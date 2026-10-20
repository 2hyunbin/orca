import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { Tab } from '../../shared/tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { chatTabLayoutCommands } from './agent-session-tab-layout-commands'

const WT = 'repo-1::/tmp/worktree-a'

function chatTab(sessionId: string, id: string, executionHostId?: ExecutionHostId): Tab {
  return {
    id,
    entityId: sessionId,
    groupId: 'group-1',
    worktreeId: WT,
    contentType: 'agent-session',
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...(executionHostId ? { executionHostId } : {})
  }
}

function session(tabs: Tab[], activeGroupId?: string): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabs: { [WT]: tabs },
    ...(activeGroupId ? { activeGroupIdByWorktree: { [WT]: activeGroupId } } : {})
  }
}

const open = (sessionId: string) => ({
  open: { sessionId, agent: 'codex' as const, tabId: `agent-session:${sessionId}` }
})

describe('a host’s chat tab changes as main’s layout commands', () => {
  it('opens a listed chat in the window’s active group, once', () => {
    expect(chatTabLayoutCommands(session([], 'group-1'), WT, [open('a'), open('a')])).toEqual([
      {
        type: 'openAgentSessionTab',
        workspace: WT,
        tabId: 'agent-session:a',
        sessionId: 'a',
        agent: 'codex',
        groupId: 'group-1'
      }
    ])
  })

  it('opens nothing for a chat a tab already shows, and names no group without an active one', () => {
    const shown = session([chatTab('a', 'saved-tab')])
    expect(chatTabLayoutCommands(shown, WT, [open('a')])).toEqual([])
    expect(chatTabLayoutCommands(null, WT, [open('b')])).toEqual([
      expect.not.objectContaining({ groupId: expect.anything() })
    ])
  })

  it('closes the tab that shows the chat, under its saved id, forced', () => {
    expect(
      chatTabLayoutCommands(session([chatTab('a', 'saved-tab')]), WT, [{ close: 'a' }])
    ).toEqual([{ type: 'closeTabs', workspace: WT, tabIds: ['saved-tab'], force: true }])
  })

  it('closes nothing for a chat no tab shows, or one a remote host owns', () => {
    const remote = session([chatTab('a', 'remote-tab', 'runtime:server-1')])
    expect(chatTabLayoutCommands(remote, WT, [{ close: 'a' }, { close: 'b' }])).toEqual([])
  })

  it('closes a chat opened earlier in the same change list, in order', () => {
    expect(
      chatTabLayoutCommands(session([]), WT, [open('a'), { close: 'a' }]).map((c) => c.type)
    ).toEqual(['openAgentSessionTab', 'closeTabs'])
  })
})
