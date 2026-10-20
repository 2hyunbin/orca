import { expect, it, vi } from 'vitest'
import {
  admitRuntimeSpawnPane,
  fixture
} from '../loading-store/profile-state-delayed-authority-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const pane = {
  worktreeId: 'repo-local::/fixture/local',
  tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
}

it.each([
  [
    'tab',
    { type: 'closeTabs' as const, workspace: pane.worktreeId, tabIds: [pane.tabId] as [string] }
  ],
  [
    'pane',
    {
      type: 'closePane' as const,
      workspace: pane.worktreeId,
      tabId: pane.tabId,
      leafId: pane.leafId
    }
  ]
])(
  'switch off: a %s close through layout.apply still refuses and rolls back on a failed write',
  async (_kind, command) => {
    const { store, authority } = await fixture()
    await admitRuntimeSpawnPane(store, pane)
    authority.failNextWrite()

    await expect(store.applyLayoutCommand(command)).rejects.toThrow('profile_state_write_failed')
    const ids = (store.getWorkspaceSession().tabsByWorktree[pane.worktreeId] ?? []).map(
      (tab) => tab.id
    )
    expect(ids).toContain(pane.tabId)
  }
)
