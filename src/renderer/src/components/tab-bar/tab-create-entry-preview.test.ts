import { expect, it, vi } from 'vitest'
import { openTabBarEntry } from './tab-create-entry-action'

const preview = vi.hoisted(() => vi.fn())
vi.mock('@/lib/open-html-file-preview', () => ({ openHtmlFilePreview: preview }))
vi.mock('@/lib/editor-file-operation-owner', () => ({
  getEditorFileOperationContext: () => {
    throw new Error('A preview must not require file mutation authorization')
  }
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ getKnownWorktreeById: () => ({ path: '/repo' }) })
  }
}))

it('opens a selected HTML preview without preparing file mutations', async () => {
  await openTabBarEntry({
    classification: { kind: 'html-file-url', filePath: '/repo/report.html' },
    query: 'file:///repo/report.html',
    worktreeId: 'remote',
    groupId: 'group-2',
    fileList: { files: [], loading: true, loadError: null }
  })
  expect(preview).toHaveBeenCalledWith({
    filePath: '/repo/report.html',
    worktreeId: 'remote',
    targetGroupId: 'group-2'
  })
})
