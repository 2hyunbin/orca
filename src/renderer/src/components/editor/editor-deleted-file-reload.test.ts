import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { FileContent } from './editor-panel-content-types'

const setExternalMutation = vi.fn()
const editorDrafts: Record<string, string> = {}
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ setExternalMutation, editorDrafts }) }
}))

import {
  applyEditorFileLoadFailure,
  isPathSpecificMissingFileError
} from './editor-deleted-file-reload'

const FILE = '/repo/a.ts'
const tab: OpenFile = {
  id: FILE,
  worktreeId: 'wt',
  filePath: FILE,
  relativePath: 'a.ts',
  language: 'typescript',
  mode: 'edit',
  isDirty: false,
  lastKnownDiskSignature: 'sig'
}
const failure: FileContent = { content: '', isBinary: false, loadError: 'gone' }
// An older paired server has no existence probe; its read fails with the host's fs message.
const oldServerReadError = new Error(
  "Error invoking runtime method 'files.read': ENOENT: no such file or directory, open '/repo/a.ts'"
)

function apply(error: unknown, previous: Record<string, FileContent>, file = tab) {
  let contents = previous
  applyEditorFileLoadFailure({
    error,
    fileId: FILE,
    filePath: FILE,
    tabs: [file],
    failure,
    setFileContents: (update) => {
      contents = typeof update === 'function' ? update(contents) : update
    }
  })
  return contents
}

describe('applyEditorFileLoadFailure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete editorDrafts[FILE]
  })

  it.each(['unsaved text', ''])(
    'keeps a reopened draft editable when its file is gone (%j)',
    (draft) => {
      editorDrafts[FILE] = draft
      const contents = apply(oldServerReadError, {}, { ...tab, isDirty: true })

      expect(contents[FILE]).toEqual({ content: '', isBinary: false })
      expect(editorDrafts[FILE]).toBe(draft)
      expect(setExternalMutation).toHaveBeenCalledWith(FILE, 'deleted')
    }
  )

  it('preserves the last disk content when a dirty tab is reloaded after deletion', () => {
    editorDrafts[FILE] = 'unsaved text'
    const contents = apply(
      oldServerReadError,
      { [FILE]: { content: 'last seen', isBinary: false, isStale: true } },
      { ...tab, isDirty: true }
    )

    expect(contents[FILE]).toEqual({ content: 'last seen', isBinary: false, isStale: false })
    expect(setExternalMutation).toHaveBeenCalledWith(FILE, 'deleted')
  })

  it('replaces a previous load error so the recovered draft can render', () => {
    editorDrafts[FILE] = 'unsaved text'
    const contents = apply(oldServerReadError, { [FILE]: failure }, { ...tab, isDirty: true })

    expect(contents[FILE]).toEqual({ content: '', isBinary: false })
  })

  it('preserves a dirty tab rename instead of replacing it with deletion', () => {
    editorDrafts[FILE] = 'unsaved text'
    const contents = apply(
      oldServerReadError,
      {},
      {
        ...tab,
        isDirty: true,
        externalMutation: 'renamed'
      }
    )

    expect(contents[FILE]).toEqual({ content: '', isBinary: false })
    expect(setExternalMutation).not.toHaveBeenCalled()
  })

  it('does not recover a clean tab merely because it has a stale draft', () => {
    editorDrafts[FILE] = 'stale text'

    expect(apply(oldServerReadError, {})[FILE]).toBe(failure)
  })

  it('shows unrelated load failures even when a dirty draft exists', () => {
    editorDrafts[FILE] = 'unsaved text'

    expect(apply(new Error('Remote connection dropped'), {}, { ...tab, isDirty: true })[FILE]).toBe(
      failure
    )
    expect(setExternalMutation).not.toHaveBeenCalled()
  })

  it('keeps the last content and marks the tab deleted when an old server reports the file gone on catch-up', () => {
    const contents = apply(oldServerReadError, {
      [FILE]: { content: 'last seen', isBinary: false, isStale: true }
    })

    expect(contents[FILE]).toEqual({ content: 'last seen', isBinary: false, isStale: false })
    expect(setExternalMutation).toHaveBeenCalledWith(FILE, 'deleted')
  })

  it.each([
    ['a whole-request not-found', new Error('worktree not found')],
    ['another file', new Error("ENOENT: no such file or directory, open '/repo/b.ts'")],
    ['a connection failure', new Error('Remote connection dropped')]
  ])('shows the read error for %s', (_label, error) => {
    const contents = apply(error, { [FILE]: { content: 'last seen', isBinary: false } })

    expect(contents[FILE]).toBe(failure)
    expect(setExternalMutation).not.toHaveBeenCalled()
  })

  it('never claims a tab that has not read the file yet or holds unsaved edits', () => {
    expect(apply(oldServerReadError, {}, { ...tab, lastKnownDiskSignature: undefined })[FILE]).toBe(
      failure
    )
    expect(apply(oldServerReadError, {}, { ...tab, isDirty: true })[FILE]).toBe(failure)
    expect(setExternalMutation).not.toHaveBeenCalled()
  })

  it('matches a path containing an apostrophe', () => {
    expect(
      isPathSpecificMissingFileError(
        new Error("ENOENT: no such file or directory, open '/repo/it's.md'"),
        "/repo/it's.md"
      )
    ).toBe(true)
  })

  it('matches the path regardless of separator spelling', () => {
    expect(
      isPathSpecificMissingFileError(
        new Error("ENOENT: no such file or directory, open 'C:\\repo\\a.ts'"),
        'C:/repo/a.ts'
      )
    ).toBe(true)
  })
})
