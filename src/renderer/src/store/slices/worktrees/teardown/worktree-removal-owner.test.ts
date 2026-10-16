import { makeUnifiedTab } from '@/components/worktree-jump-palette-test-fixtures'
import { expect, it } from 'vitest'
import { createTestStore } from '../../worktrees-slice-test-harness'
import { makeTerminalTab, makeWorktree } from '../../worktrees-slice-test-fixtures'
import { captureWorktreeStateBeforeRemoval } from './worktree-state-before-removal'
import { applyRemoveWorktreeSuccessState } from './remove-worktree-store-cleanup'

it('removes one owner while retaining the same-id survivor resources and selection', () => {
  const store = createTestStore()
  const id = 'repo1::/workspace'
  const local = makeWorktree({ id, repoId: 'repo1', hostId: 'local' })
  const remote = makeWorktree({ id, repoId: 'repo1', hostId: 'ssh:remote' })
  const tabs = ['local-tab', 'remote-tab'].map((tabId) =>
    makeTerminalTab({ id: tabId, worktreeId: id })
  )
  store.setState({
    worktreesByRepo: { repo1: [local, remote] },
    tabsByWorktree: { [id]: tabs },
    unifiedTabsByWorktree: {
      [id]: tabs.map((tab, index) => ({
        ...makeUnifiedTab(tab.id, id, tab.id, ''),
        executionHostId: index === 0 ? 'local' : 'ssh:remote',
        groupId: 'group',
        sortOrder: index
      }))
    },
    ptyIdsByTabId: { 'local-tab': ['local-pty'], 'remote-tab': ['remote-pty'] },
    groupsByWorktree: {
      [id]: [
        {
          id: 'group',
          worktreeId: id,
          activeTabId: 'local-tab',
          tabOrder: tabs.map((tab) => tab.id),
          recentTabIds: ['remote-tab', 'local-tab']
        }
      ]
    },
    tabBarOrderByWorktree: { [id]: tabs.map((tab) => tab.id) },
    openFiles: ['local', 'remote'].map((owner) => ({
      id: `${owner}-file`,
      worktreeId: id,
      filePath: `/${owner}`,
      relativePath: owner,
      language: 'plaintext',
      mode: 'edit' as const,
      isDirty: true,
      ...(owner === 'remote' ? { externalSshTargetId: 'remote' } : {})
    })),
    editorDrafts: { 'local-file': 'keep', 'remote-file': 'drop' },
    activeWorktreeId: id,
    activeWorkspaceExecutionHostId: 'local',
    activeTabId: 'local-tab',
    activeFileId: 'local-file'
  })
  const before = captureWorktreeStateBeforeRemoval(store.getState(), id, 'ssh:remote')
  expect([...before.tabIds]).toEqual(['remote-tab'])
  expect(before.terminalPtyIds).toEqual(['remote-pty'])
  applyRemoveWorktreeSuccessState(store.setState, id, new Set(before.tabIds), 'ssh:remote')
  const after = store.getState()
  expect(after.worktreesByRepo.repo1).toEqual([local])
  expect(after.tabsByWorktree[id]).toEqual([tabs[0]])
  expect(after.ptyIdsByTabId).toEqual({ 'local-tab': ['local-pty'] })
  expect(after.groupsByWorktree[id][0]).toMatchObject({
    tabOrder: ['local-tab'],
    recentTabIds: ['local-tab'],
    activeTabId: 'local-tab'
  })
  expect(after.tabBarOrderByWorktree[id]).toEqual(['local-tab'])
  expect(after.openFiles.map((file) => file.id)).toEqual(['local-file'])
  expect(after.editorDrafts).toEqual({ 'local-file': 'keep' })
  expect(after.activeWorktreeId).toBe(id)
  expect(after.activeTabId).toBe('local-tab')
  expect(after.activeFileId).toBe('local-file')
})
