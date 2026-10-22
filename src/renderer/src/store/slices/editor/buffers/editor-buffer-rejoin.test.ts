import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { assertEditorBufferInvariant } from '../../../editor-buffer-record-lifecycle'
import { makeWorktree } from '../../worktrees-slice-test-fixtures'
import type { OpenFile } from '../types/open-file'
import { requestKeepEditorBuffers } from './editor-buffer-kept'
import { isDetachedEditorBufferId } from './editor-buffer-views'

function tab(id: string, worktreeId: string, patch: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    filePath: '/repo/a.ts',
    relativePath: 'a.ts',
    worktreeId,
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    lastKnownDiskSignature: 'sig-base',
    ...patch
  }
}

const state = () => useAppStore.getState()
const view = (id: string) => state().openFiles.find((file) => file.id === id)
const recordOf = (id: string) => state().editorBufferIdOf[id]
// Why: a rejoin runs on the next microtask, after the caller finishes settling the record.
const settled = () => Promise.resolve()

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' }),
        makeWorktree({ id: 'wt-2', repoId: 'repo-1', path: '/repo', hostId: 'local' })
      ]
    }
  })
})

/** A restored divergent pair: `a` holds "abc", `b` holds "abcd" and is detached. */
function divergentPair(bPatch: Partial<OpenFile> = {}): void {
  useAppStore.setState({
    openFiles: [
      tab('a', 'wt-1', { isDirty: true }),
      tab('b', 'wt-2', { isDirty: true, ...bPatch })
    ],
    editorDrafts: { a: 'abc', b: 'abcd' }
  })
  expect(isDetachedEditorBufferId(recordOf('b'))).toBe(true)
}

describe('detached records rejoin once one side is clean', () => {
  it('stay apart while both sides hold unsaved edits', async () => {
    divergentPair()
    state().setEditorDraft('a', 'abcX')
    await settled()
    expect(recordOf('b')).not.toBe(recordOf('a'))
    expect(state().editorDrafts.b).toBe('abcd')
  })

  it('the partner saving rejoins: the dirty side wins with its own draft and old baseline', async () => {
    divergentPair()
    // As a written save settles: new baseline, clean, draft cleared.
    state().setLastKnownDiskSignature('a', 'sig-abc')
    state().markFileDirty('a', false)
    state().clearEditorDraft('a')
    expect(recordOf('b')).not.toBe(recordOf('a'))
    await settled()

    expect(recordOf('b')).toBe(recordOf('a'))
    expect(state().editorBufferDetached).toEqual({})
    for (const id of ['a', 'b']) {
      expect(state().editorDrafts[id]).toBe('abcd')
      expect(view(id)?.isDirty).toBe(true)
      // Why the old baseline: the next save is refused and raises the banner on every view.
      expect(view(id)?.lastKnownDiskSignature).toBe('sig-base')
    }
    expect(() => assertEditorBufferInvariant(state())).not.toThrow()
  })

  it('the detached side discarding rejoins as a clean view of the partner', async () => {
    divergentPair()
    state().markFileDirty('b', false)
    state().clearEditorDraft('b')
    await settled()

    expect(recordOf('b')).toBe(recordOf('a'))
    expect(state().editorDrafts.b).toBe('abc')
    expect(view('b')?.isDirty).toBe(true)
  })

  it("carries the detached side's conflict banner onto every view when it wins", async () => {
    divergentPair({ externalMutation: 'changed' })
    state().markFileDirty('a', false)
    state().clearEditorDraft('a')
    await settled()

    expect(view('a')?.externalMutation).toBe('changed')
    expect(view('b')?.externalMutation).toBe('changed')
  })

  it('takes the key when the partner closed', async () => {
    divergentPair()
    state().closeFile('a')
    await settled()

    expect(isDetachedEditorBufferId(recordOf('b'))).toBe(false)
    expect(state().editorDrafts.b).toBe('abcd')
  })
})

describe('a dirty record whose last view closed without a prompt', () => {
  function closeWithoutPrompt(ids: string[]): void {
    useAppStore.setState((s) => {
      requestKeepEditorBuffers(ids)
      return { openFiles: s.openFiles.filter((file) => !ids.includes(file.id)) }
    })
  }

  it('is kept, and reopening the file joins it: draft, dirty flag and baseline', () => {
    useAppStore.setState({
      openFiles: [tab('a', 'wt-1', { isDirty: true, lastKnownDiskSignature: 'sig-old' })],
      editorDrafts: { a: 'kept edits' }
    })
    const recordId = recordOf('a')
    closeWithoutPrompt(['a'])
    expect(Object.keys(state().editorBuffers)).toEqual([])
    expect(state().editorBufferKept[recordId]?.draft).toBe('kept edits')

    useAppStore.setState((s) => ({ openFiles: [...s.openFiles, tab('b', 'wt-2')] }))
    expect(recordOf('b')).toBe(recordId)
    expect(state().editorDrafts.b).toBe('kept edits')
    expect(view('b')?.isDirty).toBe(true)
    expect(view('b')?.lastKnownDiskSignature).toBe('sig-old')
    expect(state().editorBufferKept).toEqual({})
  })

  it('is not kept when the close asked nothing (Don’t save) or the record was clean', () => {
    useAppStore.setState({
      openFiles: [
        tab('a', 'wt-1', { isDirty: true }),
        tab('c', 'wt-1', { filePath: '/repo/c.ts' })
      ],
      editorDrafts: { a: 'discarded' }
    })
    state().closeFile('a')
    closeWithoutPrompt(['c'])
    expect(state().editorBufferKept).toEqual({})
  })

  it('leaves the kept text alone when a divergent dirty view reopens it', () => {
    useAppStore.setState({
      openFiles: [tab('a', 'wt-1', { isDirty: true })],
      editorDrafts: { a: 'kept edits' }
    })
    const recordId = recordOf('a')
    closeWithoutPrompt(['a'])
    useAppStore.setState((s) => ({
      openFiles: [...s.openFiles, tab('b', 'wt-2', { isDirty: true })],
      editorDrafts: { ...s.editorDrafts, b: 'other edits' }
    }))
    expect(state().editorDrafts.b).toBe('other edits')
    expect(state().editorBufferKept[recordId]?.draft).toBe('kept edits')
  })

  it('is dropped when its removal notice goes away', () => {
    useAppStore.setState({
      openFiles: [tab('a', 'wt-1', { isDirty: true })],
      editorDrafts: { a: 'kept edits' }
    })
    closeWithoutPrompt(['a'])
    state().releaseKeptEditorBuffers(['a'])
    expect(state().editorBufferKept).toEqual({})
  })
})
