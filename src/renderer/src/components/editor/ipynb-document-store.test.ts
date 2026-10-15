// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KernelFrame, KernelFrameEvent } from '../../../../shared/notebook-kernel-types'

const { notebookApi, frameListener, disk } = vi.hoisted(() => {
  const frameListener = { current: (_event: KernelFrameEvent): void => {} }
  const notebookApi = {
    listPythonEnvironments: async () => ({ workspace: [{ path: '/py', name: 'py' }], path: [] }),
    startKernel: async () => ({ status: 'ready' }),
    execute: vi.fn(),
    shutdownKernel: vi.fn(),
    onKernelFrame: (listener: (event: KernelFrameEvent) => void) => {
      frameListener.current = listener
      return () => {}
    }
  }
  Object.defineProperty(window, 'api', { configurable: true, value: { notebook: notebookApi } })
  const disk = { files: new Map<string, string>(), pendingWrite: Promise.resolve() }
  return { notebookApi, frameListener, disk }
})

vi.mock('@/store', async () => ({
  useAppStore: (await import('./ipynb-app-store-test-fixture')).notebookTestAppStore
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
vi.mock('@/lib/editor-file-operation-owner', () => ({
  getEditorFileOperationContext: () => ({ connectionId: null })
}))
vi.mock('@/lib/local-file-access', () => ({ editorTabFileAccess: () => undefined }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => null }))
vi.mock('@/runtime/runtime-file-read-client', () => ({ readRuntimeFileContent: vi.fn() }))
vi.mock('@/runtime/runtime-file-mutation-client', () => ({
  writeRuntimeFile: async (_context: unknown, filePath: string, content: string) => {
    await disk.pendingWrite
    disk.files.set(filePath, content)
  }
}))

import { buildEditorSessionData } from '@/lib/workspace-session'
import { flushPendingEditorChange } from './editor-buffer-owners'
import { createEditorSaveQueue } from './editor-save-queue'
import { reloadTabContentFromDisk } from './ExternalFileChangeBanner'
import { updateIpynbCellSource } from './ipynb-cell-mutations'
import {
  editNotebookDocument,
  getNotebookDocumentView,
  openNotebookDocument,
  reconcileNotebookDocument
} from './ipynb-document-store'
import { runCells, trustNotebook } from './ipynb-kernel-session'
import {
  isNotebookTestFileDirty,
  notebookTestAppStore,
  notebookTestSaveQueueStore,
  openNotebookTestFile
} from './ipynb-app-store-test-fixture'

const FILE_ID = 'nb'
const FILE_PATH = '/repo/nb.ipynb'

function notebookText(source: string, extraCellIds: string[] = []): string {
  const cell = (id: string, text: string) => ({
    id,
    cell_type: 'code',
    metadata: {},
    execution_count: null,
    outputs: [],
    source: [text]
  })
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { language_info: { name: 'python' } },
    cells: [cell('a', source), ...extraCellIds.map((id) => cell(id, ''))]
  })
}

function frame(value: KernelFrame): void {
  frameListener.current({ filePath: FILE_PATH, frame: value })
}

function stdout(text: string): void {
  frame({ type: 'stream', content: { name: 'stdout', text } })
}

function draft(): string | undefined {
  return notebookTestAppStore.getState().editorDrafts[FILE_ID]
}

function backedUpDraft(): string | undefined {
  const { openFiles, editorDrafts } = notebookTestSaveQueueStore.getState()
  const files = openFiles.map((file) => ({ ...file, mode: 'edit' as const }))
  return buildEditorSessionData(files, editorDrafts, {}, {}, {}).openFilesByWorktree?.['wt-1']?.[0]
    ?.dirtyDraftContent
}

function savedCell(text: string | undefined): Record<string, unknown> {
  return JSON.parse(text ?? '{}').cells[0]
}

async function startRun(): Promise<void> {
  trustNotebook(FILE_PATH)
  await runCells(FILE_PATH, [{ key: 'a', code: 'print(1)', fileId: FILE_ID }], '/repo')
  expect(notebookApi.execute).toHaveBeenCalled()
}

const queue = createEditorSaveQueue(notebookTestSaveQueueStore)
const save = (): Promise<void> =>
  queue.queueSave(notebookTestSaveQueueStore.getState().openFiles[0]!, undefined)

beforeEach(() => {
  vi.clearAllMocks()
  disk.files.clear()
  disk.pendingWrite = Promise.resolve()
  // Closing the tab drops the previous test's document and kernel session.
  notebookTestAppStore.setState({ openFiles: [] })
  openNotebookTestFile(FILE_ID, FILE_PATH)
  openNotebookDocument(FILE_ID, notebookText('print(1)'))
})

describe('notebook document store', () => {
  it('writes a run that finishes with no viewer into the draft, so it is dirty and saves', async () => {
    await startRun()
    stdout('1\n')
    expect(isNotebookTestFileDirty(FILE_ID)).toBe(true)
    expect(draft()).toBeUndefined()

    frame({ type: 'done', status: 'ok', execution_count: 1 })
    expect(savedCell(draft())).toMatchObject({
      execution_count: 1,
      outputs: [{ output_type: 'stream', text: ['1\n'] }]
    })
    await save()
    expect(savedCell(disk.files.get(FILE_PATH))).toMatchObject({ execution_count: 1 })
    expect(isNotebookTestFileDirty(FILE_ID)).toBe(false)
  })

  it('stays dirty when output arrives while a save is being written', async () => {
    await startRun()
    stdout('one\n')
    let finishWrite = (): void => {}
    disk.pendingWrite = new Promise((resolve) => {
      finishWrite = resolve
    })
    const saving = save()
    await vi.waitFor(() => expect(draft()).toBeDefined())
    stdout('two\n')
    finishWrite()
    await saving
    expect(savedCell(disk.files.get(FILE_PATH)).outputs).toMatchObject([{ text: ['one\n'] }])
    expect(isNotebookTestFileDirty(FILE_ID)).toBe(true)

    await save()
    expect(savedCell(disk.files.get(FILE_PATH)).outputs).toMatchObject([
      { text: ['one\n', 'two\n'] }
    ])
    expect(isNotebookTestFileDirty(FILE_ID)).toBe(false)
  })

  it('takes in the disk text on Reload from disk while a cell runs, keeping its live output', async () => {
    await startRun()
    stdout('live\n')
    reloadTabContentFromDisk(notebookTestSaveQueueStore.getState().openFiles[0]!, () => {})
    expect(draft()).toBeUndefined()
    stdout('more\n')

    reconcileNotebookDocument(FILE_ID, notebookText('print(2)', ['b']))
    frame({ type: 'done', status: 'ok', execution_count: 1 })
    const saved = JSON.parse(draft() ?? '{}')
    expect(saved.cells.map((cell: { id: string }) => cell.id)).toEqual(['a', 'b'])
    expect(saved.cells[0]).toMatchObject({
      source: ['print(2)'],
      outputs: [{ text: ['live\n', 'more\n'] }]
    })
    expect(isNotebookTestFileDirty(FILE_ID)).toBe(true)
  })

  it('saves Source text exactly and does not restore output deliberately removed there', async () => {
    const { setEditorDraft, setMarkdownViewMode } = notebookTestAppStore.getState()
    await startRun()
    stdout('1\n')
    setMarkdownViewMode(FILE_ID, 'source')
    expect(savedCell(draft()).outputs).toMatchObject([{ text: ['1\n'] }])

    setEditorDraft(FILE_ID, '{"cells": [')
    stdout('2\n')
    frame({ type: 'done', status: 'ok', execution_count: 1 })
    expect(draft()).toBe('{"cells": [')

    const typed = notebookText('print("edited")')
    setEditorDraft(FILE_ID, typed)
    await save()
    expect(disk.files.get(FILE_PATH)).toBe(typed)
    expect(isNotebookTestFileDirty(FILE_ID)).toBe(false)

    setMarkdownViewMode(FILE_ID, 'rich')
    expect(getNotebookDocumentView(FILE_ID)?.document?.cells[0]).toMatchObject({
      source: ['print("edited")'],
      outputs: []
    })
  })

  it('keeps newer live output when Source changes only code and retains normalized output', async () => {
    const { setEditorDraft, setMarkdownViewMode } = notebookTestAppStore.getState()
    await startRun()
    stdout('one\n')
    setMarkdownViewMode(FILE_ID, 'source')
    const source = JSON.parse(draft() ?? '{}')
    source.cells[0].source = ['print("edited")']
    setEditorDraft(FILE_ID, JSON.stringify(source))
    stdout('two\n')
    frame({ type: 'done', status: 'ok', execution_count: 1 })

    setMarkdownViewMode(FILE_ID, 'rich')
    expect(savedCell(draft())).toMatchObject({
      source: ['print("edited")'],
      outputs: [{ text: ['one\n', 'two\n'] }]
    })
  })

  it('classifies exact Source text with or without a retained document and preserves malformed text', () => {
    const { setEditorDraft, setMarkdownViewMode } = notebookTestAppStore.getState()
    const large = JSON.parse(notebookText('print(1)'))
    large.cells[0].outputs = [
      { output_type: 'stream', name: 'stdout', text: ['x'.repeat(10_000 * 1024 + 1)] }
    ]
    setMarkdownViewMode(FILE_ID, 'source')
    setEditorDraft(FILE_ID, JSON.stringify(large))
    notebookTestAppStore.getState().markFileDirty(FILE_ID, true)
    expect(backedUpDraft()).toBeUndefined()

    setEditorDraft(FILE_ID, notebookText('print(2)'))
    expect(backedUpDraft()).toBe(draft())
    setEditorDraft(FILE_ID, '{"cells": [')
    expect(backedUpDraft()).toBe('{"cells": [')
    setMarkdownViewMode(FILE_ID, 'rich')
    expect(backedUpDraft()).toBe('{"cells": [')

    notebookTestAppStore.setState({ openFiles: [] })
    openNotebookTestFile(FILE_ID, FILE_PATH)
    notebookTestAppStore.getState().setEditorDraft(FILE_ID, JSON.stringify(large))
    notebookTestAppStore.getState().markFileDirty(FILE_ID, true)
    expect(backedUpDraft()).toBeUndefined()
    notebookTestAppStore.getState().setEditorDraft(FILE_ID, '{"cells": [')
    expect(backedUpDraft()).toBe('{"cells": [')
  })

  it('backs up only under 10,000 KB of output; past it, an edit writes no draft until a flush', async () => {
    const editSource = (source: string): void =>
      editNotebookDocument(FILE_ID, (document) => updateIpynbCellSource(document, 0, source), 'now')
    editSource('print(2)')
    expect(backedUpDraft()).toBe(draft())
    await startRun()
    stdout(`${'x'.repeat(10_000 * 1024)}\n`)
    frame({ type: 'done', status: 'ok', execution_count: 1 })
    editSource('print(3)')
    expect(savedCell(draft())).toMatchObject({ source: ['print(2)'], outputs: [] })
    expect(backedUpDraft()).toBeUndefined()
    flushPendingEditorChange(FILE_ID)
    expect(savedCell(draft())).toMatchObject({ source: ['print(3)'], execution_count: 1 })
    expect(backedUpDraft()).toBeUndefined()

    await startRun()
    expect(savedCell(draft())).toMatchObject({ source: ['print(3)'], outputs: [] })
    expect(backedUpDraft()).toBe(draft())
  })
})
