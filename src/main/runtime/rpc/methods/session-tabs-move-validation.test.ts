import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'

const WT = 'repo-1::/home/orca/worktree'
const LEAF = '11111111-1111-4111-8111-111111111111'

type SeededTab =
  | { kind: 'terminal'; id: string }
  | { kind: 'browser'; id: string; pageId: string }
  | { kind: 'editor'; id: string }

const tabRow = (tab: SeededTab, groupId: string, sortOrder: number) => ({
  id: tab.id,
  entityId: tab.id,
  groupId,
  worktreeId: WT,
  contentType: tab.kind,
  label: tab.id,
  customLabel: null,
  color: null,
  sortOrder,
  createdAt: 1
})

/** The Store's session for one worktree whose groups hold `groups` (group id -> tabs in order). */
function sessionWith(
  groups: Record<string, SeededTab[]>,
  activeGroupId: string
): WorkspaceSessionState {
  const all = Object.values(groups).flat()
  const terminals = all.filter((tab) => tab.kind === 'terminal')
  const browsers = all.flatMap((tab) => (tab.kind === 'browser' ? [tab] : []))
  const editors = all.filter((tab) => tab.kind === 'editor')
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WT]: terminals.map((tab, index) => ({
        id: tab.id,
        ptyId: null,
        worktreeId: WT,
        title: tab.id,
        customTitle: null,
        color: null,
        sortOrder: index,
        createdAt: 1
      }))
    },
    terminalLayoutsByTabId: Object.fromEntries(
      terminals.map((tab) => [
        tab.id,
        { root: { type: 'leaf', leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
      ])
    ),
    openFilesByWorktree: {
      [WT]: editors.map((tab) => ({
        filePath: tab.id,
        relativePath: tab.id,
        worktreeId: WT,
        language: 'markdown'
      }))
    },
    browserTabsByWorktree: {
      [WT]: browsers.map((tab) => ({
        id: tab.id,
        worktreeId: WT,
        activePageId: tab.pageId,
        pageIds: [tab.pageId],
        url: `https://example.test/${tab.id}`,
        title: tab.id,
        loading: false,
        faviconUrl: null,
        canGoBack: false,
        canGoForward: false,
        loadError: null,
        createdAt: 1
      }))
    },
    browserPagesByWorkspace: Object.fromEntries(
      browsers.map((tab) => [
        tab.id,
        [
          {
            id: tab.pageId,
            workspaceId: tab.id,
            worktreeId: WT,
            url: `https://example.test/${tab.id}`,
            title: tab.id,
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      ])
    ),
    unifiedTabs: {
      [WT]: Object.entries(groups).flatMap(([groupId, tabs]) =>
        tabs.map((tab, index) => tabRow(tab, groupId, index))
      )
    },
    tabGroups: {
      [WT]: Object.entries(groups).map(([id, tabs]) => ({
        id,
        worktreeId: WT,
        activeTabId: tabs[0]!.id,
        tabOrder: tabs.map((tab) => tab.id)
      }))
    },
    activeGroupIdByWorktree: { [WT]: activeGroupId }
  }
}

function runtimeWith(session: WorkspaceSessionState): OrcaRuntimeService {
  let saved = session
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only the workspace session and repo list in this suite.
  return new OrcaRuntimeService({
    getWorkspaceSession: () => saved,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      saved = next
    },
    getRepos: () => [{ id: 'repo-1' }],
    getSettings: () => ({ workspaceDir: '/tmp/workspaces' })
  } as never)
}

/** The order the runtime's layout holds for a group, hidden tabs included. */
const heldOrder = (runtime: OrcaRuntimeService, groupId: string) =>
  runtime.heldWorkspaceLayout(WT)?.groups.find((group) => group.id === groupId)?.tabOrder

const liveBrowserPages = (runtime: OrcaRuntimeService, pageIds: string[]): void => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: move validation reads only tabList from the agent browser bridge.
  runtime.setAgentBrowserBridge({
    tabList: vi.fn(() => ({
      tabs: pageIds.map((browserPageId) => ({ browserPageId, title: 'Live', url: 'https://x' }))
    }))
  } as never)
}

describe('session tab move validation', () => {
  it('publishes a structured tab into the active group instead of the first group', async () => {
    const runtime = runtimeWith(
      sessionWith(
        {
          'group-1': [{ kind: 'terminal', id: 'terminal-tab' }],
          'group-2': [{ kind: 'editor', id: 'README.md' }]
        },
        'group-2'
      )
    )

    await runtime.publishStructuredAgentSessionTab({
      workspaceId: WT,
      sessionId: 'session-a',
      agent: 'codex',
      activate: true
    })

    const snapshot = await runtime.listMobileSessionTabs(`id:${WT}`)
    expect(snapshot.activeGroupId).toBe('group-2')
    expect(snapshot.tabGroups?.[0]?.tabOrder).toEqual(['terminal-tab'])
    expect(snapshot.tabGroups?.[1]).toMatchObject({
      activeTabId: 'agent-session:session-a',
      tabOrder: ['README.md', 'agent-session:session-a']
    })
  })

  it('preserves a capability-hidden structured tab during an old-client reorder', async () => {
    const runtime = runtimeWith(
      sessionWith(
        {
          'group-1': [
            { kind: 'terminal', id: 'terminal-tab' },
            { kind: 'editor', id: 'README.md' }
          ]
        },
        'group-1'
      )
    )
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: WT,
      sessionId: 'session-a',
      agent: 'codex',
      activate: false
    })

    await runtime.moveMobileSessionTab(`id:${WT}`, {
      kind: 'reorder',
      tabId: 'README.md',
      targetGroupId: 'group-1',
      tabOrder: ['README.md', 'terminal-tab']
    })

    const snapshot = await runtime.listMobileSessionTabs(`id:${WT}`)
    expect(snapshot.tabGroups?.[0]?.tabOrder).toEqual([
      'README.md',
      'terminal-tab',
      'agent-session:session-a'
    ])
  })

  it('validates reorder moves against sanitized visible tab groups', async () => {
    const runtime = runtimeWith(
      sessionWith(
        {
          'group-1': [
            { kind: 'terminal', id: 'terminal-tab' },
            { kind: 'browser', id: 'browser-stale', pageId: 'page-stale' },
            { kind: 'browser', id: 'browser-live', pageId: 'page-live' }
          ]
        },
        'group-1'
      )
    )
    liveBrowserPages(runtime, ['page-live'])

    await expect(
      runtime.moveMobileSessionTab(`id:${WT}`, {
        kind: 'reorder',
        tabId: 'browser-live',
        targetGroupId: 'group-1',
        tabOrder: ['browser-live', 'terminal-tab']
      })
    ).resolves.toEqual({ moved: true })

    // The stale page the client cannot see keeps its place.
    expect(heldOrder(runtime, 'group-1')).toEqual(['browser-live', 'browser-stale', 'terminal-tab'])
  })

  it('rejects moves into groups hidden from the sanitized session model', async () => {
    const runtime = runtimeWith(
      sessionWith(
        {
          'group-visible': [{ kind: 'terminal', id: 'terminal-tab' }],
          'group-hidden': [{ kind: 'browser', id: 'browser-stale', pageId: 'page-stale' }]
        },
        'group-visible'
      )
    )
    liveBrowserPages(runtime, [])

    await expect(
      runtime.moveMobileSessionTab(`id:${WT}`, {
        kind: 'split',
        tabId: 'terminal-tab',
        targetGroupId: 'group-hidden',
        splitDirection: 'right'
      })
    ).rejects.toThrow('target_group_not_found')
  })

  it('rejects reorder moves when the moved tab is absent from the target order', async () => {
    const runtime = runtimeWith(
      sessionWith(
        {
          'group-1': [{ kind: 'terminal', id: 'terminal-tab' }],
          'group-2': [{ kind: 'browser', id: 'browser-live', pageId: 'page-live' }]
        },
        'group-1'
      )
    )
    liveBrowserPages(runtime, ['page-live'])

    await expect(
      runtime.moveMobileSessionTab(`id:${WT}`, {
        kind: 'reorder',
        tabId: 'browser-live',
        targetGroupId: 'group-1',
        tabOrder: ['terminal-tab']
      })
    ).rejects.toThrow('invalid_tab_order')
  })
})
