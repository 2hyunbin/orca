import { makeOpenFile, makeTabGroup } from '../../store-session-test-harness'
import { makeUnifiedTab } from '@/components/worktree-jump-palette-test-fixtures'
import { expect, it } from 'vitest'
import '../../worktrees-slice-test-harness'
import { createTestStore } from '../../store-test-helpers'
import { deriveNotesSendAgentTargets } from '@/lib/notes-send-agent-targets'
import { makeTerminalTab, makeWorktree } from '../../worktrees-slice-test-fixtures'
import { captureWorktreeStateBeforeRemoval } from './worktree-state-before-removal'
import { applyRemoveWorktreeSuccessState } from './remove-worktree-store-cleanup'

it('removes an owner with send mode open, then removes its last survivor', async () => {
  const store = createTestStore()
  const id = 'repo1::/workspace'
  const local = makeWorktree({ id, repoId: 'repo1', hostId: 'local' })
  const remote = makeWorktree({ id, repoId: 'repo1', hostId: 'runtime:E' })
  const leafId = '11111111-1111-4111-8111-111111111111'
  const tabs = ['t', 'remote-tab', 'web-terminal-t'].map((tabId) =>
    makeTerminalTab({ id: tabId, worktreeId: id, title: 'Codex ready' })
  )
  store.setState({
    worktreesByRepo: { repo1: [local, remote] },
    tabsByWorktree: { [id]: tabs },
    unifiedTabsByWorktree: {
      [id]: tabs.slice(0, 2).map((tab, index) => ({
        ...makeUnifiedTab(tab.id, id, tab.id, ''),
        executionHostId: index === 0 ? 'local' : 'runtime:E',
        groupId: 'group',
        sortOrder: index
      }))
    },
    ptyIdsByTabId: Object.fromEntries(tabs.map((tab) => [tab.id, [tab.id]])),
    terminalLayoutsByTabId: Object.fromEntries(
      tabs.map((tab) => [
        tab.id,
        {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: tab.id }
        }
      ])
    ),
    groupsByWorktree: {
      [id]: [
        makeTabGroup({
          id: 'group',
          worktreeId: id,
          activeTabId: 't',
          tabOrder: tabs.map((tab) => tab.id),
          recentTabIds: ['remote-tab', 't']
        })
      ]
    },
    tabBarOrderByWorktree: { [id]: tabs.map((tab) => tab.id) },
    openFiles: ['local', 'remote'].map((owner) =>
      makeOpenFile({
        id: `${owner}-file`,
        worktreeId: id,
        isDirty: true,
        ...(owner === 'remote' ? { runtimeEnvironmentId: 'E' } : {})
      })
    ),
    editorDrafts: { 'local-file': 'keep', 'remote-file': 'drop' },
    activeWorktreeId: id,
    activeWorkspaceExecutionHostId: 'local',
    activeTabId: 't',
    activeFileId: 'local-file'
  })
  const paneKey = `t:${leafId}`
  store
    .getState()
    .setAgentStatus(paneKey, { state: 'done', agentType: 'codex', prompt: '' }, '', undefined, {
      worktreeId: id
    })
  store.getState().openAgentSendPopoverTargetMode({
    id: 'notes',
    worktreeId: id,
    source: 'diff-notes',
    prompt: 'Review',
    label: 'Notes',
    launchSource: 'notes_send'
  })
  expect(deriveNotesSendAgentTargets(store.getState(), id).map((target) => target.tabId)).toContain(
    'web-terminal-t'
  )
  const before = captureWorktreeStateBeforeRemoval(store.getState(), id, 'runtime:E')
  expect([...before.tabIds]).toEqual(['remote-tab', 'web-terminal-t'])
  expect(before.terminalPtyIds).toEqual(['remote-tab', 'web-terminal-t'])
  await store.getState().shutdownWorktreeTerminals(id, {
    tabIds: before.tabIds,
    backendOwnsPtyTeardown: true,
    shutdownReason: 'remove-worktree'
  })
  applyRemoveWorktreeSuccessState(store.setState, id, new Set(before.tabIds), 'runtime:E')
  const after = store.getState()
  expect(after.worktreesByRepo.repo1).toEqual([local])
  expect(after.tabsByWorktree[id]).toEqual([tabs[0]])
  expect(after.ptyIdsByTabId).toEqual({ t: ['t'] })
  expect(after.groupsByWorktree[id][0]).toMatchObject({
    tabOrder: ['t'],
    recentTabIds: ['t'],
    activeTabId: 't'
  })
  expect(after.tabBarOrderByWorktree[id]).toEqual(['t'])
  expect(after.openFiles.map((file) => file.id)).toEqual(['local-file'])
  expect(after.editorDrafts).toEqual({ 'local-file': 'keep' })
  expect(after.activeWorktreeId).toBe(id)
  expect(after.activeTabId).toBe('t')
  expect(after.activeFileId).toBe('local-file')
  expect(after.agentSendPopoverTargetMode?.worktreeId).toBe(id)
  expect(after.agentStatusByPaneKey[paneKey]).toBeDefined()
  expect(deriveNotesSendAgentTargets(after, id).map((target) => target.tabId)).toEqual(['t'])
  await store.getState().shutdownWorktreeTerminals(id, {
    backendOwnsPtyTeardown: true,
    shutdownReason: 'remove-worktree'
  })
  const last = captureWorktreeStateBeforeRemoval(store.getState(), id, 'local')
  applyRemoveWorktreeSuccessState(store.setState, id, new Set(last.tabIds), 'local')
  expect(store.getState().agentStatusByPaneKey).toEqual({})
  expect(deriveNotesSendAgentTargets(store.getState(), id)).toEqual([])
})
