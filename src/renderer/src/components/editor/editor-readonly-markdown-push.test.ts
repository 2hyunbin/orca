// Why: a read-only tab renders raw Monaco source on the shared model whatever its file type, so it
// must show a writable view's unsaved edits (one record), never push disk text over them.
import { beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { mayPushTabTextIntoModel } from './editor-stale-mount-guard'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'

function tab(id: string, filePath: string, patch: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    filePath,
    relativePath: filePath.slice('/repo/'.length),
    worktreeId: 'wt-1',
    language: filePath.endsWith('.csv') ? 'csv' : 'markdown',
    isDirty: false,
    mode: 'edit',
    lastKnownDiskSignature: 'sig',
    ...patch
  }
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  // A resolved local owner, so both tabs map to one model URI.
  useAppStore.setState({
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' })]
    }
  })
})

it.each(['/repo/notes.md', '/repo/data.csv', '/repo/log.jsonl'])(
  'a read-only %s view joins a dirty writable view and shows its edits, not disk text',
  (filePath) => {
    useAppStore.setState({
      openFiles: [tab('writable', filePath, { isDirty: true })],
      editorDrafts: { writable: 'unsaved edits' },
      markdownViewMode: { writable: 'source' }
    })
    useAppStore.setState((s) => ({
      openFiles: [...s.openFiles, tab('read-only', filePath, { readOnly: true })]
    }))

    // Views of one file share a record: the read-only view joins it and shows the unsaved edits.
    const state = useAppStore.getState()
    expect(state.openFiles.find((file) => file.id === 'read-only')?.isDirty).toBe(true)
    expect(state.editorDrafts['read-only']).toBe('unsaved edits')
    expect(state.editorBufferIdOf['read-only']).toBe(state.editorBufferIdOf.writable)
  }
)

it('a read-only view may still load disk text into a clean model', () => {
  useAppStore.setState({
    openFiles: [
      tab('writable', '/repo/notes.md'),
      tab('read-only', '/repo/notes.md', { readOnly: true })
    ],
    markdownViewMode: { writable: 'source' }
  })
  expect(mayPushTabTextIntoModel('read-only')).toBe(true)
})
