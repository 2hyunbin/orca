import { describe, expect, it, vi } from 'vitest'
import * as layoutLoad from '../../../shared/workspace-layout/workspace-layout-load'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { LEGACY_WORKSPACE_LAYOUT_PROFILES } from '../../../shared/workspace-layout/workspace-layout-legacy-profile.test-fixture'
import { WORKSPACE_LAYOUT_PROFILES } from '../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { deriveHeadlessLegacyTerminalLeafId } from '../mobile-session-layout-projection'
import { getDefaultSettings } from '../../../shared/constants'
import { OrcaRuntimeService } from '../orca-runtime'

const repos = ['repo-1', 'repo-ssh', 'repo-server'].map((id) => ({
  id,
  path: `/repos/${id}`,
  displayName: id,
  badgeColor: 'blue',
  addedAt: 1
}))

function runtimeFor(session: WorkspaceSessionState) {
  return new OrcaRuntimeService({
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getRepos: () => repos,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    addRepo: () => {},
    updateRepo: () => {
      throw new Error('unused')
    },
    setWorktreeMeta: () => {
      throw new Error('unused')
    },
    removeWorktreeMeta: () => {},
    getGitHubCache: () => ({ pr: {}, issue: {} }),
    getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
    addRetiredWorktreeName: () => {},
    mergeRetiredWorktreeNames: () => false,
    getSettings: () => getDefaultSettings('/tmp/home'),
    getWorkspaceSession: () => session,
    setWorkspaceSession: () => {}
  })
}

/** What a phone is sent per workspace when no window publishes: terminal panes and groups. */
function phoneView(name: string) {
  const profile = [...WORKSPACE_LAYOUT_PROFILES, ...LEGACY_WORKSPACE_LAYOUT_PROFILES].find(
    (entry) => entry.name === name
  )!
  const runtime = runtimeFor(profile.build())
  runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(undefined, { force: true })
  return [...runtime.mobileSessionTabsByWorktree.values()].map((snapshot) => ({
    panes: snapshot.tabs.flatMap((tab) =>
      tab.type === 'terminal' ? [`${tab.parentTabId} ${tab.ptyId ?? '-'} ${tab.title}`] : []
    ),
    groups: snapshot.tabGroups?.map((group) => group.tabOrder),
    active: snapshot.activeTabId?.split('::')[0]
  }))
}

describe('headless phone tabs come from the shared Loader', () => {
  it('does not list a legacy row whose terminals a tab-bar tab already shows', () => {
    expect(phoneView('legacy row repeating a tab-bar tab’s terminal')).toEqual([
      {
        panes: ['tab-a pty-a Terminal 1', 'tab-b pty-b Terminal 2'],
        groups: [['tab-a', 'tab-b']],
        active: 'tab-a'
      }
    ])
  })

  it('moves a selection on the dropped row to the tab that shows its terminal', () => {
    expect(phoneView('legacy row repeating a tab-bar tab’s terminal, selected')[0]?.active).toBe(
      'tab-a'
    )
  })

  it('shows a terminal in one pane only when a legacy split row repeats it', () => {
    expect(
      phoneView('legacy split row sharing one pane’s terminal with a tab-bar tab')[0]?.panes
    ).toEqual([
      'tab-a pty-a Terminal 1',
      'tab-b pty-b Terminal 2',
      'tab-legacy - Terminal 3',
      'tab-legacy pty-c Terminal 3'
    ])
  })

  it('keeps group distribution and SSH and remote-server partitions as before', () => {
    expect(
      phoneView('local desktop (git worktree, folder workspace, all tab kinds)')[0]?.groups
    ).toEqual([['tab-shell', 'term-agent', 'editor:src/app.ts'], ['tab-unbound']])
    expect(phoneView('tab listed by two groups, its tab-bar entry naming the second')).toEqual([
      {
        panes: ['tab-a pty-a Terminal 1', 'tab-b pty-b Terminal 2'],
        groups: [['tab-a'], ['tab-b']],
        active: 'tab-a'
      }
    ])
    expect(phoneView('relay SSH host partition')[0]?.panes).toEqual([
      'tab-ssh-1 ssh:target-1@@pty-1 Terminal 1',
      'tab-ssh-1 ssh:target-1@@pty-2 Terminal 1',
      'tab-ssh-2 ssh:target-1@@pty-3 Terminal 2'
    ])
    expect(phoneView('remote server partition')[0]?.panes).toEqual([
      'tab-server remote:env-1@@handle-1 Terminal 1'
    ])
  })

  it('builds a partition without a repeat from the stored rows unchanged', () => {
    // Each fixture here differs from the Loader's result in a title, a closed pane or a pane id.
    expect(phoneView('tab-bar label differing from the row title')[0]?.panes).toEqual([
      'tab-a pty-a Terminal 1',
      'tab-b pty-b Terminal 2'
    ])
    expect(
      phoneView('legacy surface tombstone on a pane still showing its terminal')[0]?.panes
    ).toEqual(['tab-a pty-a Terminal 1', 'tab-b pty-b Terminal 2'])
    const session = emptySession()
    session.tabsByWorktree[GIT_KEY] = [
      {
        id: 'tab-old',
        ptyId: 'pty-old',
        worktreeId: GIT_KEY,
        title: 'Terminal 1',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]
    const runtime = runtimeFor(session)
    runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(undefined, { force: true })
    const [tab] = runtime.mobileSessionTabsByWorktree.get(GIT_KEY)?.tabs ?? []
    expect(tab?.type === 'terminal' && tab.leafId).toBe(
      deriveHeadlessLegacyTerminalLeafId('tab-old')
    )
  })

  it.each([false, true])(
    'loads a partition only when it repeats a terminal, once per listing (repeat=%s)',
    async (repeat) => {
      let session = emptySession()
      for (const [n, name] of ['a', 'b', 'c'].entries()) {
        session = addWorkspace(session, `repo-1::/repos/repo-1/${name}`, [
          {
            id: `g-${name}`,
            tabs: [{ id: `tab-${name}`, leaves: [[leaf(n + 1), `ssh:target-1@@pty-${name}`]] }]
          }
        ])
      }
      if (repeat) {
        const [row] = session.tabsByWorktree['repo-1::/repos/repo-1/a']!
        session.tabsByWorktree['repo-1::/repos/repo-1/a']!.push({ ...row!, id: 'tab-a-copy' })
      }
      const load = vi.spyOn(layoutLoad, 'loadWorkspaceLayoutWithoutReport')
      try {
        await runtimeFor(session).listAllMobileSessionTabs()
        expect(load).toHaveBeenCalledTimes(repeat ? 1 : 0)
      } finally {
        load.mockRestore()
      }
    }
  )

  it('does not count a relay terminal id reused by a later incarnation as a repeat', async () => {
    const key = 'repo-1::/repos/repo-1/a'
    const session = addWorkspace(emptySession(), key, [
      {
        id: 'g-a',
        tabs: [
          { id: 'tab-a', leaves: [[leaf(1), 'ssh:target-1@@pty-1']] },
          { id: 'tab-b', leaves: [[leaf(2), 'ssh:target-1@@pty-1']] }
        ]
      }
    ])
    session.terminalPtyIncarnationsByPaneKey = {
      [`tab-a:${leaf(1)}`]: 'incarnation-1',
      [`tab-b:${leaf(2)}`]: 'incarnation-2'
    }
    const load = vi.spyOn(layoutLoad, 'loadWorkspaceLayoutWithoutReport')
    try {
      await runtimeFor(session).listAllMobileSessionTabs()
      expect(load).not.toHaveBeenCalled()
    } finally {
      load.mockRestore()
    }
  })

  it('drops a legacy row repeating an SSH relay terminal with no incarnation recorded', () => {
    const profile = LEGACY_WORKSPACE_LAYOUT_PROFILES.find(
      (entry) => entry.name === 'legacy row repeating a tab-bar tab’s terminal'
    )!
    const session: WorkspaceSessionState = JSON.parse(
      JSON.stringify(profile.build()).replaceAll('"pty-a"', '"ssh:target-1@@pty-1"')
    )
    const runtime = runtimeFor(session)
    runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(undefined, { force: true })
    expect(
      runtime.mobileSessionTabsByWorktree
        .get(GIT_KEY)
        ?.tabs.flatMap((tab) => (tab.type === 'terminal' ? [tab.parentTabId] : []))
    ).toEqual(['tab-a', 'tab-b'])
  })
})
