import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../shared/runtime-types'

const callMock = vi.fn()

vi.mock('./runtime-client', () => {
  class RuntimeClient {
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }

  class RuntimeClientError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  return { RuntimeClient, RuntimeClientError }
})

import { main } from './index'
import { okFixture, queueFixtures } from './test-fixtures'
import { formatWorkspaceTabList, projectWorkspaceTabRows } from './workspace-tab-rows'

function snapshot(
  worktree: string,
  tabs: RuntimeMobileSessionTabsResult['tabs']
): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs
  }
}

const MIXED = snapshot('repo::/w/app', [
  {
    type: 'terminal',
    id: 'term-tab::leaf-a',
    title: 'zsh',
    parentTabId: 'term-tab',
    leafId: 'leaf-a',
    status: 'ready',
    terminal: 'term_a',
    isActive: false
  },
  {
    type: 'terminal',
    id: 'term-tab::leaf-b',
    title: 'zsh',
    parentTabId: 'term-tab',
    leafId: 'leaf-b',
    status: 'ready',
    terminal: 'term_b',
    isActive: false
  },
  {
    type: 'agent-session',
    id: 'agent-session:s1',
    title: 'Claude chat',
    sessionId: 's1',
    agent: 'claude',
    isActive: true
  },
  {
    type: 'file',
    id: 'file-1',
    title: 'App.tsx',
    filePath: '/w/app/src/App.tsx',
    relativePath: 'src/App.tsx',
    language: 'typescript',
    isDirty: true,
    isPinned: true,
    isActive: false
  },
  {
    type: 'browser',
    id: 'browser-tab-1',
    title: 'Local',
    browserWorkspaceId: 'browser-tab-1',
    browserPageId: 'page-1',
    url: 'http://localhost:3000',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    isActive: false
  }
])

describe('projectWorkspaceTabRows', () => {
  it('lists every tab kind and folds a split terminal into one row', () => {
    expect(projectWorkspaceTabRows(MIXED)).toEqual([
      {
        tabId: 'term-tab',
        kind: 'terminal',
        title: 'zsh',
        active: false,
        pinned: false,
        worktreeId: 'repo::/w/app',
        terminals: ['term_a', 'term_b']
      },
      {
        tabId: 'agent-session:s1',
        kind: 'chat',
        title: 'Claude chat',
        active: true,
        pinned: false,
        worktreeId: 'repo::/w/app',
        sessionId: 's1',
        agent: 'claude'
      },
      {
        tabId: 'file-1',
        kind: 'editor',
        title: 'App.tsx',
        active: false,
        pinned: true,
        worktreeId: 'repo::/w/app',
        filePath: '/w/app/src/App.tsx',
        unsaved: true
      },
      {
        tabId: 'browser-tab-1',
        kind: 'browser',
        title: 'Local',
        active: false,
        pinned: false,
        worktreeId: 'repo::/w/app',
        browserPageId: 'page-1',
        url: 'http://localhost:3000'
      }
    ])
  })

  it('leaves a terminal pane without a handle out of the handle list', () => {
    const rows = projectWorkspaceTabRows(
      snapshot('repo::/w/app', [
        {
          type: 'terminal',
          id: 'term-tab::leaf-a',
          title: 'zsh',
          parentTabId: 'term-tab',
          leafId: 'leaf-a',
          status: 'pending-handle',
          terminal: null,
          isActive: true
        }
      ])
    )
    expect(rows[0]).toMatchObject({ tabId: 'term-tab', terminals: [], active: true })
    expect(formatWorkspaceTabList({ tabs: rows })).toBe(
      '* term-tab  terminal  zsh  handle unavailable'
    )
  })
})

describe('orca tab list', () => {
  beforeEach(() => {
    callMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads every worktree from the host tab list and prints one line per tab', async () => {
    queueFixtures(
      callMock,
      okFixture('req_tabs', {
        snapshots: [MIXED, snapshot('repo::/w/other', [])]
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['tab', 'list', '--worktree', 'all'], '/tmp/not-an-orca-worktree')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock.mock.calls[0]?.[0]).toBe('session.tabs.listAll')
    expect(logSpy).toHaveBeenCalledWith(
      [
        '  term-tab  terminal  zsh  term_a, term_b',
        '* agent-session:s1  chat  Claude chat  claude',
        '  file-1  editor  App.tsx  /w/app/src/App.tsx (unsaved)',
        '  browser-tab-1  browser  Local  page-1  http://localhost:3000'
      ].join('\n')
    )
  })

  it('returns the rows as tabs in JSON', async () => {
    queueFixtures(callMock, okFixture('req_tabs', { snapshots: [MIXED] }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['tab', 'list', '--worktree', 'all', '--json'], '/tmp/not-an-orca-worktree')

    const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
    expect(Object.keys(printed.result)).toEqual(['tabs'])
    expect(printed.result.tabs.map((row: { kind: string }) => row.kind)).toEqual([
      'terminal',
      'chat',
      'editor',
      'browser'
    ])
  })

  it.each(['agentSessionsUnverifiable', 'clientHostedPagesUnreconciled'] as const)(
    'preserves an empty held inventory with %s in JSON and text',
    async (hold) => {
      const held = { ...snapshot('repo::/w/held', []), [hold]: true }
      queueFixtures(callMock, okFixture('req_json', held), okFixture('req_text', held))
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await main(['tab', 'list', '--worktree', 'id:repo::/w/held', '--json'], '/tmp')
      await main(['tab', 'list', '--worktree', 'id:repo::/w/held'], '/tmp')

      expect(callMock.mock.calls.map((call) => call[0])).toEqual([
        'session.tabs.list',
        'session.tabs.list'
      ])
      expect(JSON.parse(String(logSpy.mock.calls[0]?.[0])).result).toEqual({
        tabs: [],
        incompleteWorktrees: [{ worktreeId: held.worktree, [hold]: true }]
      })
      expect(logSpy.mock.calls[1]?.[0]).toBe(
        `Inventory incomplete for ${held.worktree}: ${
          hold === 'agentSessionsUnverifiable'
            ? 'chat inventory unavailable'
            : 'client-hosted browser inventory not yet reconciled'
        }.`
      )
    }
  )

  it('keeps holds scoped to their worktrees and still prints available rows', async () => {
    const held = {
      ...snapshot('repo::/w/held', []),
      agentSessionsUnverifiable: true as const
    }
    const partial = {
      ...MIXED,
      clientHostedPagesUnreconciled: true as const
    }
    const both = {
      ...snapshot('folder-workspace', []),
      agentSessionsUnverifiable: true as const,
      clientHostedPagesUnreconciled: true as const
    }
    const result = { snapshots: [held, partial, snapshot('complete-empty', []), both] }
    queueFixtures(callMock, okFixture('req_json', result), okFixture('req_text', result))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['tab', 'list', '--worktree', 'all', '--json'], '/tmp')
    await main(['tab', 'list', '--worktree', 'all'], '/tmp')

    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0])).result).toEqual({
      tabs: projectWorkspaceTabRows(MIXED),
      incompleteWorktrees: [
        { worktreeId: held.worktree, agentSessionsUnverifiable: true },
        { worktreeId: partial.worktree, clientHostedPagesUnreconciled: true },
        {
          worktreeId: both.worktree,
          agentSessionsUnverifiable: true,
          clientHostedPagesUnreconciled: true
        }
      ]
    })
    expect(logSpy.mock.calls[1]?.[0]).toBe(
      [
        'Inventory incomplete for repo::/w/held: chat inventory unavailable.',
        'Inventory incomplete for repo::/w/app: client-hosted browser inventory not yet reconciled.',
        'Inventory incomplete for folder-workspace: chat inventory unavailable; client-hosted browser inventory not yet reconciled.',
        formatWorkspaceTabList({ tabs: projectWorkspaceTabRows(MIXED) })
      ].join('\n')
    )
  })

  it('keeps a complete empty inventory unchanged in JSON and text', async () => {
    const empty = snapshot('folder-workspace', [])
    queueFixtures(callMock, okFixture('req_json', empty), okFixture('req_text', empty))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['tab', 'list', '--worktree', 'id:folder-workspace', '--json'], '/tmp')
    await main(['tab', 'list', '--worktree', 'id:folder-workspace'], '/tmp')

    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0])).result).toEqual({ tabs: [] })
    expect(logSpy.mock.calls[1]?.[0]).toBe('No tabs open.')
  })

  it('prints an unavailable terminal handle without claiming a launch is in progress', async () => {
    const sleeping = snapshot('folder-workspace', [
      {
        type: 'terminal',
        id: 'sleeping::leaf',
        parentTabId: 'sleeping',
        leafId: 'leaf',
        title: 'Sleeping shell',
        status: 'pending-handle',
        terminal: null,
        isActive: false
      }
    ])
    queueFixtures(callMock, okFixture('req_tabs', sleeping))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['tab', 'list', '--worktree', 'id:folder-workspace'], '/tmp')

    expect(logSpy).toHaveBeenCalledWith('  sleeping  terminal  Sleeping shell  handle unavailable')
  })

  it('orders each worktree by its own groups without mixing identical tab ids', async () => {
    const first = {
      ...MIXED,
      tabGroups: [
        {
          id: 'g',
          activeTabId: null,
          tabOrder: ['agent-session:s1', 'file-1', 'term-tab', 'browser-tab-1']
        }
      ]
    }
    const second = {
      ...MIXED,
      worktree: 'folder-workspace',
      tabGroups: [
        {
          id: 'g',
          activeTabId: null,
          tabOrder: ['browser-tab-1', 'term-tab', 'file-1', 'agent-session:s1']
        }
      ]
    }
    queueFixtures(callMock, okFixture('req_tabs', { snapshots: [first, second] }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['tab', 'list', '--worktree', 'all', '--json'], '/tmp')

    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0])).result).toEqual({
      tabs: [...projectWorkspaceTabRows(first), ...projectWorkspaceTabRows(second)]
    })
    expect(projectWorkspaceTabRows(first).map((row) => row.tabId)).toEqual([
      'agent-session:s1',
      'file-1',
      'term-tab',
      'browser-tab-1'
    ])
    expect(projectWorkspaceTabRows(second).map((row) => row.tabId)).toEqual([
      'browser-tab-1',
      'term-tab',
      'file-1',
      'agent-session:s1'
    ])
  })
})
