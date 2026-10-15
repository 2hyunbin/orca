import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { LEGACY_WORKSPACE_LAYOUT_PROFILES } from '../../shared/workspace-layout/workspace-layout-legacy-profile.test-fixture'
import { WORKSPACE_LAYOUT_PROFILES } from '../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import { getDefaultSettings } from '../../shared/constants'
import { OrcaRuntimeService } from './orca-runtime'

const repos = ['repo-1', 'repo-ssh', 'repo-server'].map((id) => ({
  id,
  path: `/repos/${id}`,
  displayName: id,
  badgeColor: 'blue',
  addedAt: 1
}))

/** What a phone is sent per workspace when no window publishes: terminal panes and groups. */
function phoneView(name: string) {
  const profile = [...WORKSPACE_LAYOUT_PROFILES, ...LEGACY_WORKSPACE_LAYOUT_PROFILES].find(
    (entry) => entry.name === name
  )!
  const session: WorkspaceSessionState = profile.build()
  const runtime = new OrcaRuntimeService({
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
})
