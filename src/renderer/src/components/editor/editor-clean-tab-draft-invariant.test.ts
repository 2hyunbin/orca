// Why: the invariant every transition must keep: a tab that is not dirty holds no draft of the disk
// text, so no stale draft can later be restored into a shared model.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { requestEditorFileSave } from './editor-autosave'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import { reloadTabContentFromDisk } from './ExternalFileChangeBanner'
import { mayPushTabTextIntoModel } from './editor-stale-mount-guard'
import { rollBackFailedMobileSave } from '@/runtime/mobile-markdown-save-rollback'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import { GUARDED_PATH, stubGuardedDisk } from './editor-save-guarded-disk-fixture'

const storeRef = vi.hoisted((): { current: ReturnType<typeof createEditorStore> | null } => ({
  current: null
}))

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeRef.current?.getState() } }))

function openCleanTab(disk: string) {
  const store = createEditorStore()
  storeRef.current = store
  store.getState().openFile({
    filePath: GUARDED_PATH,
    relativePath: 'file.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    mode: 'edit'
  })
  const id = store.getState().openFiles[0].id
  store.getState().setLastKnownDiskSignature(id, getDiskBaselineSignature(disk))
  return { store, id }
}

function expectNoCleanDraft(store: ReturnType<typeof createEditorStore>): void {
  for (const tab of store.getState().openFiles) {
    if (!tab.isDirty) {
      expect(store.getState().editorDrafts[tab.id]).toBeUndefined()
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  stubGuardedDisk({ [GUARDED_PATH]: 'disk' })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __clearSelfWriteRegistryForTests()
})

it('undo back to the disk text drops the draft', () => {
  const { store, id } = openCleanTab('disk')
  store.getState().setEditorDraft(id, 'disk typed')
  store.getState().markFileDirty(id, true)
  store.getState().setEditorDraft(id, 'disk')
  store.getState().markFileDirty(id, false)
  expectNoCleanDraft(store)
})

it('a clean tab that gets a draft of the disk text drops it when marked clean again', () => {
  const { store, id } = openCleanTab('disk')
  store.getState().setEditorDraft(id, 'disk')
  store.getState().markFileDirty(id, false)
  expectNoCleanDraft(store)
})

it('save completion leaves no draft on the now-clean tab', async () => {
  const { store, id } = openCleanTab('disk')
  store.getState().setEditorDraft(id, 'saved text')
  store.getState().markFileDirty(id, true)
  const cleanup = attachEditorAutosaveController(store)
  try {
    await requestEditorFileSave({ fileId: id })
    expectNoCleanDraft(store)
  } finally {
    cleanup()
  }
})

it('reload leaves no draft', () => {
  const { store, id } = openCleanTab('disk')
  store.getState().setEditorDraft(id, 'mine')
  store.getState().markFileDirty(id, true)
  reloadTabContentFromDisk(store.getState().openFiles[0], vi.fn())
  expectNoCleanDraft(store)
})

it('a refused mobile save restoring a clean tab leaves no draft of the disk text', () => {
  const { store, id } = openCleanTab('disk')
  store.getState().setEditorDraft(id, 'phone')
  store.getState().markFileDirty(id, true)
  rollBackFailedMobileSave(new Error('save_timeout'), {
    fileId: id,
    injectedContent: 'phone',
    previousDraft: 'disk',
    previousDirty: false,
    stampedBaseline: null
  })
  expectNoCleanDraft(store)
})

it("never restores a clean tab's leftover draft into the model", () => {
  const { store, id } = openCleanTab('disk')
  // A Markdown-whitespace draft may stay on a clean tab; it still never enters the model.
  store.setState({ editorDrafts: { ...store.getState().editorDrafts, [id]: 'disk ' } })
  expect(mayPushTabTextIntoModel(id)).toBe(false)
  store.getState().markFileDirty(id, true)
  expect(mayPushTabTextIntoModel(id)).toBe(true)
})
