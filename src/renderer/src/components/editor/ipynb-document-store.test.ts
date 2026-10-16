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

import { createEditorSaveQueue } from './editor-save-queue'
import { reloadTabContentFromDisk } from './ExternalFileChangeBanner'
import { sameStoredOutputs, updateIpynbCellSource } from './ipynb-cell-mutations'
import {
  beginNotebookReload,
  editNotebookDocument,
  getNotebookDocumentView,
  openNotebookDocument,
  settleNotebookReload
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
    expect(draft()).toBeUndefined()
    await save()
    expect(savedCell(disk.files.get(FILE_PATH))).toMatchObject({
      execution_count: 1,
      outputs: [{ output_type: 'stream', text: ['1\n'] }]
    })
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
    const reload = beginNotebookReload(FILE_ID)!
    const queued = save()
    expect(settleNotebookReload(reload, notebookText('disk'))).toBe(false)
    finishWrite()
    await saving
    expect(savedCell(disk.files.get(FILE_PATH)).outputs).toMatchObject([{ text: ['one\n'] }])
    expect(isNotebookTestFileDirty(FILE_ID)).toBe(true)

    await queued
    expect(savedCell(disk.files.get(FILE_PATH)).outputs).toMatchObject([
      { text: ['one\n', 'two\n'] }
    ])
    expect(isNotebookTestFileDirty(FILE_ID)).toBe(false)
  })

  it('takes in the disk text on Reload from disk while a cell runs, keeping its live output', async () => {
    await startRun()
    stdout('live\n')
    let reload: ReturnType<typeof beginNotebookReload> = null
    reloadTabContentFromDisk(
      notebookTestSaveQueueStore.getState().openFiles[0]!,
      (_file, token) => {
        reload = token ?? null
      }
    )
    stdout('more\n')
    frame({ type: 'done', status: 'ok', execution_count: 1 })
    expect(settleNotebookReload(reload!, notebookText('print(2)', ['b']))).toBe(true)
    const saved = JSON.parse(draft() ?? '{}')
    expect(saved.cells.map((cell: { id: string }) => cell.id)).toEqual(['a', 'b'])
    expect(saved.cells[0]).toMatchObject({
      source: ['print(2)'],
      outputs: [{ text: ['live\n', 'more\n'] }]
    })
    expect(isNotebookTestFileDirty(FILE_ID)).toBe(true)
  })

  it('never writes over Source view text; saving there writes it exactly, output follows on leaving', async () => {
    const { setEditorDraft, setMarkdownViewMode } = notebookTestAppStore.getState()
    await startRun()
    stdout('1\n')
    setMarkdownViewMode(FILE_ID, 'source')
    expect(savedCell(draft()).outputs).toMatchObject([{ text: ['1\n'] }])
    const original = draft()!

    setEditorDraft(FILE_ID, '{"cells": [')
    stdout('2\n')
    frame({ type: 'done', status: 'ok', execution_count: 1 })
    expect(draft()).toBe('{"cells": [')
    setMarkdownViewMode(FILE_ID, 'rich')
    expect(getNotebookDocumentView(FILE_ID)?.error).not.toBeNull()
    setMarkdownViewMode(FILE_ID, 'source')
    setEditorDraft(FILE_ID, original)
    setMarkdownViewMode(FILE_ID, 'rich')
    expect(getNotebookDocumentView(FILE_ID)?.error).toBeNull()
    setMarkdownViewMode(FILE_ID, 'source')

    const typed = notebookText('print("edited")')
    setEditorDraft(FILE_ID, typed)
    await save()
    expect(disk.files.get(FILE_PATH)).toBe(typed)
    expect(isNotebookTestFileDirty(FILE_ID)).toBe(true)

    setMarkdownViewMode(FILE_ID, 'rich')
    expect(savedCell(draft())).toMatchObject({
      source: ['print("edited")'],
      outputs: [{ text: ['1\n', '2\n'] }]
    })
  })

  it('keeps a no-output completion count through an unrelated Source edit', async () => {
    const { setEditorDraft, setMarkdownViewMode } = notebookTestAppStore.getState()
    await startRun()
    setMarkdownViewMode(FILE_ID, 'source')
    frame({ type: 'done', status: 'ok', execution_count: 7 })
    setEditorDraft(FILE_ID, notebookText('print(1)', ['b']))
    setMarkdownViewMode(FILE_ID, 'rich')
    expect(savedCell(draft()).execution_count).toBe(7)
  })

  it('keeps the prior model until accepted read, then carries completed and queued results', async () => {
    await startRun()
    await runCells(FILE_PATH, [{ key: 'b', code: 'print(2)', fileId: FILE_ID }], '/repo')
    const reload = beginNotebookReload(FILE_ID)!
    stdout('first\n')
    frame({ type: 'done', status: 'ok', execution_count: 1 })
    await vi.waitFor(() => expect(draft()).toBeDefined())
    stdout('second\n')
    frame({ type: 'done', status: 'ok', execution_count: 2 })
    expect(savedCell(draft()).source).toEqual(['print(1)'])
    expect(settleNotebookReload(reload, notebookText('disk', ['b']))).toBe(true)
    expect(savedCell(draft())).toMatchObject({
      source: ['disk'],
      execution_count: 1,
      outputs: [{ text: ['first\n'] }]
    })
    expect(JSON.parse(draft() ?? '{}').cells[1]).toMatchObject({
      execution_count: 2,
      outputs: [{ text: ['second\n'] }]
    })
  })

  it('keeps live stream and display identity when the accepted disk result is already saved', async () => {
    await startRun()
    frame({
      type: 'display_data',
      content: { data: { 'text/plain': 'before' }, metadata: {}, transient: { display_id: 'd' } }
    })
    stdout('a\nb\n')
    const diskText = JSON.parse(notebookText('print(1)'))
    diskText.cells[0].outputs = [
      { output_type: 'display_data', data: { 'text/plain': 'before' }, metadata: {} },
      { output_type: 'stream', name: 'stdout', text: ['a\n', 'b\n'] }
    ]
    const reload = beginNotebookReload(FILE_ID)!
    expect(settleNotebookReload(reload, JSON.stringify(diskText))).toBe(true)
    expect(isNotebookTestFileDirty(FILE_ID)).toBe(false)

    stdout('c\n')
    frame({
      type: 'update_display_data',
      content: { data: { 'text/plain': 'after' }, metadata: {}, transient: { display_id: 'd' } }
    })
    await save()
    expect(savedCell(disk.files.get(FILE_PATH)).outputs).toMatchObject([
      { data: { 'text/plain': 'after' } },
      { text: ['a\n', 'b\n', 'c\n'] }
    ])
    vi.useFakeTimers()
    try {
      frame({ type: 'done', status: 'ok', execution_count: 4 })
      vi.advanceTimersByTime(300)
      editNotebookDocument(
        FILE_ID,
        (document) => updateIpynbCellSource(document, 0, 'edited'),
        'debounced'
      )
      vi.advanceTimersByTime(100)
      expect(savedCell(draft())).toMatchObject({ source: ['edited'], execution_count: 4 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps line breaks significant in saved stream output', () => {
    const live = [{ output_type: 'stream', text: 'ab' }]
    const saved = [{ output_type: 'stream', text: ['a', 'b'] }]
    expect(sameStoredOutputs(live, saved)).toBe(false)
  })

  it('routes a running result to a new same-host document owner', async () => {
    await startRun()
    const file = notebookTestAppStore.getState().openFiles[0]!
    const operationProvenance = {
      generation: { route: { executionHostId: 'local', runtimeEnvironmentId: null } }
    }
    const migrating = { ...file, pendingOwnerMigration: true, operationProvenance }
    const moved = { ...file, id: 'moved', operationProvenance }
    notebookTestAppStore.setState({ openFiles: [migrating] })
    notebookTestAppStore.setState({ openFiles: [moved] })
    stdout('moved\n')
    frame({ type: 'done', status: 'ok', execution_count: 3 })
    expect(getNotebookDocumentView('moved')?.document?.cells[0]).toMatchObject({
      execution_count: 3,
      outputs: [{ text: 'moved\n' }]
    })
  })
})
