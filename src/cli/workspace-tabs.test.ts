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
    expect(formatWorkspaceTabList({ tabs: rows })).toBe('* term-tab  terminal  zsh  starting')
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
    expect(printed.result.tabs.map((row: { kind: string }) => row.kind)).toEqual([
      'terminal',
      'chat',
      'editor',
      'browser'
    ])
  })
})
