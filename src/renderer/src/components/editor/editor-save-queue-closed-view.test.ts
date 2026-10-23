import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { needsSavePromptOnClose } from '@/store/slices/editor/buffers/editor-buffer-close-rule'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import { createEditorSaveQueue, type EditorSaveQueue } from './editor-save-queue'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'
import { ORCA_EDITOR_FILE_SAVED_EVENT, type EditorFileSavedDetail } from './editor-autosave'
import { withRecordDiskText } from './editor-buffer-adapter'
import { isEditorContentUnchanged } from './editor-content-dirty-state'
import {
  createEditorStore,
  createFakeEditorDisk,
  stubEditorWindowWithDisk,
  type FakeEditorDisk
} from './editor-autosave-controller-test-fixture'

vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))

const PATH = '/repo/a.md'
const WORKTREES = {
  'repo-1': [
    makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' }),
    makeWorktree({ id: 'wt-2', repoId: 'repo-1', path: '/repo', hostId: 'local' })
  ]
}

function tab(id: string, worktreeId: string): OpenFile {
  return {
    id,
    filePath: PATH,
    relativePath: 'a.md',
    worktreeId,
    language: 'markdown',
    isDirty: false,
    mode: 'edit',
    lastKnownDiskSignature: getDiskBaselineSignature('disk')
  }
}

// One file open in two workspaces (one record), autosave off, the saving tab closed mid-write.
describe('editor save queue: the saving view closes mid-write', () => {
  let disk: FakeEditorDisk
  let store: ReturnType<typeof createEditorStore>
  let queue: EditorSaveQueue
  // Each view's loaded disk text: the editor panel's dirty-compare baseline, kept by the saved event.
  let loaded: Record<string, { content: string; isBinary: boolean }>
  let release: () => void

  const view = (id: string): OpenFile => {
    const found = store.getState().openFiles.find((openFile) => openFile.id === id)
    if (!found) {
      throw new Error(`no view ${id}`)
    }
    return found
  }
  const type = (id: string, text: string): void => {
    store.getState().setEditorDraft(id, text)
    store
      .getState()
      .markFileDirty(id, !isEditorContentUnchanged(text, loaded[id]?.content ?? '', true))
  }
  const onSaved = (event: Event): void => {
    if (!(event instanceof CustomEvent)) {
      return
    }
    const detail: EditorFileSavedDetail = event.detail
    loaded = withRecordDiskText(
      loaded,
      detail.recordViewIds ?? [detail.fileId],
      detail.fileId,
      detail.content
    )
    // As the panel does for an open saving view.
    if (store.getState().openFiles.some((file) => file.id === detail.fileId)) {
      loaded = { ...loaded, [detail.fileId]: { content: detail.content, isBinary: false } }
    }
  }
  const holdNextWrite = (refuse = false): void => {
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    disk.fs.writeFile.mockImplementationOnce(
      async ({ filePath, content }: { filePath: string; content: string }) => {
        await gate
        if (refuse) {
          return { ok: false, diskConflict: 'changed' }
        }
        disk.files.set(filePath, content)
        return { ok: true }
      }
    )
  }
  const closeView = (id: string): void => {
    store.setState((s) => ({ openFiles: s.openFiles.filter((file) => file.id !== id) }))
  }

  beforeEach(() => {
    vi.useFakeTimers()
    disk = stubEditorWindowWithDisk(createFakeEditorDisk({ [PATH]: 'disk' }))
    store = createEditorStore()
    store.setState({
      worktreesByRepo: WORKTREES,
      openFiles: [tab('A', 'wt-1'), tab('B', 'wt-2')]
    })
    // Autosave off: nothing calls syncAutoSave, so only explicit saves write.
    queue = createEditorSaveQueue(store)
    loaded = { A: { content: 'disk', isBinary: false }, B: { content: 'disk', isBinary: false } }
    window.addEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, onSaved)
    expect(store.getState().editorBufferIdOf.A).toBe(store.getState().editorBufferIdOf.B)
  })

  afterEach(() => {
    window.removeEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, onSaved)
    queue.dispose()
    __clearSelfWriteRegistryForTests()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('undoing the saved edit in the other view leaves it dirty, so closing it asks', async () => {
    type('A', 'edit')
    holdNextWrite()
    const saved = queue.queueSave(view('A'), 'edit')
    await vi.advanceTimersByTimeAsync(0)
    closeView('A')
    release()
    await expect(saved).resolves.toBe('written')

    expect(disk.files.get(PATH)).toBe('edit')
    expect(view('B').isDirty).toBe(false)
    expect(view('B').lastKnownDiskSignature).toBe(getDiskBaselineSignature('edit'))
    expect(store.getState().editorDrafts.B).toBeUndefined()
    expect(loaded.B?.content).toBe('edit')

    // B undoes the saved change: its text now differs from disk.
    type('B', 'disk')
    expect(view('B').isDirty).toBe(true)
    expect(needsSavePromptOnClose(store.getState(), 'B')).toBe(true)
    expect(disk.files.get(PATH)).toBe('edit')
  })

  it('keeps the other view dirty when it typed past the write', async () => {
    type('A', 'edit')
    holdNextWrite()
    const saved = queue.queueSave(view('A'), 'edit')
    await vi.advanceTimersByTimeAsync(0)
    closeView('A')
    type('B', 'edit, more')
    release()
    await expect(saved).resolves.toBe('written')

    expect(view('B').isDirty).toBe(true)
    expect(store.getState().editorDrafts.B).toBe('edit, more')
    expect(view('B').lastKnownDiskSignature).toBe(getDiskBaselineSignature('edit'))
  })

  it('a save queued behind the running one still writes the record through the view left', async () => {
    type('A', 'edit')
    holdNextWrite()
    const first = queue.queueSave(view('A'), 'edit')
    await vi.advanceTimersByTimeAsync(0)
    type('A', 'edit 2')
    const second = queue.queueSave(view('A'), 'edit 2')
    closeView('A')
    release()

    await expect(first).resolves.toBe('written')
    await expect(second).resolves.toBe('written')
    expect(disk.files.get(PATH)).toBe('edit 2')
    expect(view('B').isDirty).toBe(false)
    expect(view('B').lastKnownDiskSignature).toBe(getDiskBaselineSignature('edit 2'))
    expect(loaded.B?.content).toBe('edit 2')
  })
  it.each([
    ['a rich markdown view', (): void => store.getState().setMarkdownViewMode('B', 'rich')],
    [
      'listed after a read-only view',
      (): void => {
        store.setState({ openFiles: [] })
        store.setState({
          openFiles: [tab('A', 'wt-1'), { ...tab('log', 'wt-2'), readOnly: true }, tab('B', 'wt-2')]
        })
        expect(store.getState().editorBufferViews[store.getState().editorBufferIdOf.B]).toEqual([
          'A',
          'log',
          'B'
        ])
      }
    ]
  ])('settles the record when the view left is %s', async (_name, makeB) => {
    makeB()
    type('A', 'edit')
    holdNextWrite()
    const saved = queue.queueSave(view('A'), 'edit')
    await vi.advanceTimersByTimeAsync(0)
    closeView('A')
    release()
    await expect(saved).resolves.toBe('written')

    expect(view('B').isDirty).toBe(false)
    expect(view('B').lastKnownDiskSignature).toBe(getDiskBaselineSignature('edit'))
    expect(store.getState().editorDrafts.B).toBeUndefined()
  })

  it('a refused write banners the view left', async () => {
    type('A', 'edit')
    holdNextWrite(true)
    const saved = queue.queueSave(view('A'), 'edit')
    await vi.advanceTimersByTimeAsync(0)
    closeView('A')
    release()
    await expect(saved).resolves.toBe('blocked-stale')

    expect(view('B').externalMutation).toBe('changed')
    expect(view('B').isDirty).toBe(true)
    expect(store.getState().editorDrafts.B).toBe('edit')
  })

  it('writes through the view left when the writer closes while another record holds the file', async () => {
    // Divergent dirty drafts keep C off the A+B record, but both write the same file.
    store.setState({ openFiles: [] })
    store.setState({
      worktreesByRepo: {
        'repo-1': [
          ...WORKTREES['repo-1'],
          makeWorktree({ id: 'wt-3', repoId: 'repo-1', path: '/repo', hostId: 'local' })
        ]
      },
      openFiles: [
        { ...tab('A', 'wt-1'), isDirty: true },
        { ...tab('B', 'wt-2'), isDirty: true },
        { ...tab('C', 'wt-3'), isDirty: true }
      ],
      editorDrafts: { A: 'mine', B: 'mine', C: 'theirs' }
    })
    const recordOf = (id: string): string => store.getState().editorBufferIdOf[id]
    expect(recordOf('A')).toBe(recordOf('B'))
    expect(recordOf('C')).not.toBe(recordOf('A'))
    holdNextWrite()
    const theirs = queue.queueSave(view('C'), 'theirs', 'overwrite')
    await vi.advanceTimersByTimeAsync(0)
    const mine = queue.queueSave(view('A'), 'mine', 'overwrite')
    await vi.advanceTimersByTimeAsync(0)
    closeView('A')
    release()

    await expect(theirs).resolves.toBe('written')
    await expect(mine).resolves.toBe('written')
    expect(disk.files.get(PATH)).toBe('mine')
    expect(view('B').isDirty).toBe(false)
  })
})
