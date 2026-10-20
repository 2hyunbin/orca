import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'
import type { AppState } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import {
  createEditorStore,
  stubEditorWindowWithDisk,
  type FakeEditorDisk
} from '@/components/editor/editor-autosave-controller-test-fixture'
import { createEditorSaveQueue, type EditorSaveQueue } from '@/components/editor/editor-save-queue'
import { attachEditorAutosaveController } from '@/components/editor/editor-autosave-controller'
import {
  ORCA_EDITOR_SAVE_AND_CLOSE_EVENT,
  requestEditorSaveQuiesce
} from '@/components/editor/editor-autosave'
import { trackKeepEditsBaselineRead } from '@/components/editor/editor-keep-edits-baseline'
import { __clearSelfWriteRegistryForTests } from '@/components/editor/editor-self-write-registry'
import { assertEditorBufferInvariant } from '@/store/editor-buffer-record-lifecycle'
import { getDiskBaselineSignature } from '../../../../../../shared/disk-baseline-signature'
import { editorBufferIdOf } from './editor-buffer-record'
import { reloadTabContentFromDisk } from '@/components/editor/ExternalFileChangeBanner'
import type * as RuntimeFileReadClient from '@/runtime/runtime-file-read-client'

type HeldRead = { filePath: string; resolve: (content: string) => void }
const fixture = vi.hoisted((): { store: StoreApi<AppState> | null; reads: HeldRead[] } => ({
  store: null,
  reads: []
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => fixture.store?.getState() }
}))
// Why a held read: the races need a disk read that lands after a write from the other side.
vi.mock('@/runtime/runtime-file-read-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeFileReadClient>()),
  readRuntimeFileContent: ({ filePath }: { filePath: string }) =>
    new Promise((resolve) => {
      fixture.reads.push({
        filePath,
        resolve: (content) => resolve({ content, isBinary: false })
      })
    })
}))

const FILE = '/repo/a.ts'
const sig = getDiskBaselineSignature

describe('records of one file kept apart by different drafts', () => {
  let store: StoreApi<AppState>
  let disk: FakeEditorDisk
  let queue: EditorSaveQueue

  function tab(id: string) {
    return store.getState().openFiles.find((file) => file.id === id)
  }
  function type(id: string, text: string): void {
    store.getState().setEditorDraft(id, text)
    store.getState().markFileDirty(id, true)
  }
  /** Two restored tabs of FILE with different drafts over the same disk version. */
  function restoreDivergent(): [string, string] {
    disk.files.set(FILE, 'disk v0')
    store.setState({
      openFiles: ['wt-1', 'wt-2'].map((worktreeId) => ({
        id: `${worktreeId}:a`,
        filePath: FILE,
        relativePath: 'a.ts',
        worktreeId,
        language: 'typescript',
        mode: 'edit' as const,
        isDirty: true,
        lastKnownDiskSignature: sig('disk v0')
      })),
      editorDrafts: { 'wt-1:a': 'draft one', 'wt-2:a': 'draft two' }
    })
    expect(Object.keys(store.getState().editorBuffers)).toHaveLength(2)
    return ['wt-1:a', 'wt-2:a']
  }
  /** The disk text a Reload from Disk finds, landed in the same step that drops the draft. */
  function reload(id: string): void {
    store.getState().clearEditorDraft(id)
    store.getState().setExternalMutation(id, null)
    store.getState().setLastKnownDiskSignature(id, sig(disk.files.get(FILE) ?? ''))
    store.getState().markFileDirty(id, false)
  }

  beforeEach(() => {
    disk = stubEditorWindowWithDisk()
    store = createEditorStore()
    fixture.store = store
    fixture.reads = []
    store.setState({
      browserTabsByWorktree: {},
      tabsByWorktree: {},
      activeBrowserTabIdByWorktree: {},
      unifiedTabsByWorktree: {},
      folderWorkspaces: [],
      worktreesByRepo: {
        'repo-1': ['wt-1', 'wt-2'].map((id) =>
          makeWorktree({ id, repoId: 'repo-1', path: '/repo', hostId: 'local' })
        )
      }
    })
    queue = createEditorSaveQueue(store)
  })

  afterEach(() => {
    queue.dispose()
    assertEditorBufferInvariant(store.getState())
    vi.unstubAllGlobals()
    __clearSelfWriteRegistryForTests()
  })

  it("the second side's autosave is refused on the host and shows the banner", async () => {
    const [a, b] = restoreDivergent()

    expect(await queue.queueSave(tab(a)!, 'draft one', 'autosave')).toBe('written')
    expect(tab(b)?.externalMutation).toBe('changed')
    store.getState().setExternalMutation(b, null)
    expect(await queue.queueSave(tab(b)!, 'draft two', 'autosave')).toBe('blocked-stale')

    expect(disk.files.get(FILE)).toBe('draft one')
    expect(tab(b)?.externalMutation).toBe('changed')
    expect(store.getState().editorDrafts[b]).toBe('draft two')
  })

  it("the banner's explicit save overwrites", async () => {
    const [a, b] = restoreDivergent()
    await queue.queueSave(tab(a)!, 'draft one', 'user')

    expect(await queue.queueSave(tab(b)!, 'draft two', 'user')).toBe('written')
    expect(disk.files.get(FILE)).toBe('draft two')
  })

  it("a reloaded side shows disk text, never the other side's draft", async () => {
    const [a, b] = restoreDivergent()
    await queue.queueSave(tab(a)!, 'draft one', 'user')
    type(a, 'A again')
    reload(b)

    expect(store.getState().editorDrafts[b]).toBeUndefined()
    expect(tab(b)?.isDirty).toBe(false)
    expect(editorBufferIdOf(store.getState(), b)).not.toBe(editorBufferIdOf(store.getState(), a))
  })

  it('A saves, B reloads, A autosaves, B types: B edits the current text, never stale text', async () => {
    const [a, b] = restoreDivergent()
    await queue.queueSave(tab(a)!, 'draft one', 'user')
    type(a, 'A again')
    reload(b)
    expect(await queue.queueSave(tab(a)!, 'A again', 'autosave')).toBe('written')

    // Both sides are clean now, so B rejoins A and edits the text A wrote.
    expect(editorBufferIdOf(store.getState(), b)).toBe(editorBufferIdOf(store.getState(), a))
    expect(tab(b)?.lastKnownDiskSignature).toBe(sig('A again'))
    type(b, 'A again plus B')
    expect(await queue.queueSave(tab(b)!, 'A again plus B', 'autosave')).toBe('written')
  })

  it('B typing on reloaded text while A still holds edits gets the banner when A writes', async () => {
    const [a, b] = restoreDivergent()
    await queue.queueSave(tab(a)!, 'draft one', 'user')
    type(a, 'A again')
    reload(b)
    type(b, 'B on reloaded text')

    expect(await queue.queueSave(tab(a)!, 'A again', 'autosave')).toBe('written')
    expect(tab(b)?.externalMutation).toBe('changed')
    store.getState().setExternalMutation(b, null)
    expect(await queue.queueSave(tab(b)!, 'B on reloaded text', 'autosave')).toBe('blocked-stale')
    expect(disk.files.get(FILE)).toBe('A again')
  })

  it('both sides clean rejoin with the newest disk version, so later saves are not refused', async () => {
    const [a, b] = restoreDivergent()
    await queue.queueSave(tab(a)!, 'draft one', 'user')
    await queue.queueSave(tab(b)!, 'draft two', 'user')

    const state = store.getState()
    expect(editorBufferIdOf(state, a)).toBe(editorBufferIdOf(state, b))
    expect(tab(a)?.lastKnownDiskSignature).toBe(sig('draft two'))

    type(a, 'after rejoin')
    expect(await queue.queueSave(tab(a)!, 'after rejoin', 'autosave')).toBe('written')
    expect(disk.files.get(FILE)).toBe('after rejoin')
  })

  it('save-and-close after Keep My Edits waits for the baseline read and closes only once written', async () => {
    const [a, b] = restoreDivergent()
    await queue.queueSave(tab(a)!, 'draft one', 'user')
    queue.dispose()
    // Keep My Edits: the banner clears now; the disk version it consented to arrives later.
    store.getState().setExternalMutation(b, null)
    let landRead = (): void => {}
    trackKeepEditsBaselineRead(
      b,
      new Promise<void>((resolve) => {
        landRead = () => {
          store.getState().setLastKnownDiskSignature(b, sig('draft one'))
          resolve()
        }
      })
    )
    const detach = attachEditorAutosaveController(store)

    window.dispatchEvent(
      new CustomEvent(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, { detail: { fileId: b } })
    )
    await Promise.resolve()
    expect(disk.files.get(FILE)).toBe('draft one')
    landRead()
    await vi.waitFor(() => expect(tab(b)).toBeUndefined())
    detach()

    expect(disk.files.get(FILE)).toBe('draft two')
  })

  it('save-and-close refused as stale keeps the tab and its draft', async () => {
    const [a, b] = restoreDivergent()
    await queue.queueSave(tab(a)!, 'draft one', 'user')
    queue.dispose()
    store.getState().setExternalMutation(b, null)
    const detach = attachEditorAutosaveController(store)

    window.dispatchEvent(
      new CustomEvent(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, { detail: { fileId: b } })
    )
    await vi.waitFor(() => expect(tab(b)?.externalMutation).toBe('changed'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    detach()

    expect(tab(b)).toBeDefined()
    expect(store.getState().editorDrafts[b]).toBe('draft two')
    expect(disk.files.get(FILE)).toBe('draft one')
  })

  it('a save queued before the other side wrote keeps its precondition', async () => {
    const [a, b] = restoreDivergent()

    const [first, second] = await Promise.all([
      queue.queueSave(tab(a)!, 'draft one', 'user'),
      // Asked for before A wrote: A's write then marks B changed, which is not consent.
      queue.queueSave(tab(b)!, 'draft two', 'user')
    ])

    expect([first, second]).toEqual(['written', 'blocked-stale'])
    expect(disk.files.get(FILE)).toBe('draft one')
    expect(store.getState().editorDrafts[b]).toBe('draft two')
  })

  it("Reload through the banner reads first, and a read older than the other side's write is dropped", async () => {
    const [a, b] = restoreDivergent()
    await queue.queueSave(tab(a)!, 'draft one', 'user')
    type(a, 'A again')

    reloadTabContentFromDisk(tab(b)!, vi.fn())
    // Read first: B keeps its draft until the disk text is in hand.
    expect(store.getState().editorDrafts[b]).toBe('draft two')
    const staleRead = fixture.reads.at(-1)!
    expect(await queue.queueSave(tab(a)!, 'A again', 'autosave')).toBe('written')
    staleRead.resolve('draft one')
    await Promise.resolve()
    await Promise.resolve()

    expect(store.getState().editorDrafts[b]).toBe('draft two')
    expect(tab(b)?.isDirty).toBe(true)
    expect(editorBufferIdOf(store.getState(), b)).not.toBe(editorBufferIdOf(store.getState(), a))

    reloadTabContentFromDisk(tab(b)!, vi.fn())
    fixture.reads.at(-1)!.resolve('A again')
    await vi.waitFor(() => expect(tab(b)?.isDirty).toBe(false))
    expect(store.getState().editorDrafts[b]).toBeUndefined()
    expect(tab(b)?.lastKnownDiskSignature).toBe(sig('A again'))
    expect(editorBufferIdOf(store.getState(), b)).toBe(editorBufferIdOf(store.getState(), a))
  })

  it('save-and-close superseded while it waits keeps the tab and its draft', async () => {
    const [, b] = restoreDivergent()
    queue.dispose()
    let landRead = (): void => {}
    trackKeepEditsBaselineRead(
      b,
      new Promise<void>((resolve) => {
        landRead = resolve
      })
    )
    const detach = attachEditorAutosaveController(store)

    window.dispatchEvent(
      new CustomEvent(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, { detail: { fileId: b } })
    )
    // Staging the file quiesces its saves while this one waits.
    const quiesced = requestEditorSaveQuiesce({ fileId: b })
    landRead()
    await quiesced
    await new Promise((resolve) => setTimeout(resolve, 0))
    detach()

    expect(tab(b)).toBeDefined()
    expect(store.getState().editorDrafts[b]).toBe('draft two')
  })

  it('a save superseded mid-write still rebaselines to the written text', async () => {
    const [a] = restoreDivergent()
    let finishWrite = (): void => {}
    disk.fs.writeFile.mockImplementationOnce(
      async ({ filePath, content }: { filePath: string; content: string }) => {
        await new Promise<void>((resolve) => {
          finishWrite = resolve
        })
        disk.files.set(filePath, content)
        return { ok: true }
      }
    )

    const save = queue.queueSave(tab(a)!, 'draft one', 'user')
    await vi.waitFor(() => expect(disk.fs.writeFile).toHaveBeenCalled())
    queue.bumpSaveGeneration(a)
    finishWrite()

    expect(await save).toBe('written')
    expect(tab(a)?.lastKnownDiskSignature).toBe(sig('draft one'))
  })
})
