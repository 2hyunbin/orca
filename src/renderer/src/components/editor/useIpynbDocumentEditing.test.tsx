// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPendingEditorChange } from './editor-buffer-owners'
import { parseIpynb, parseIpynbDocumentView } from './ipynb-parse'
import { notebookTestAppStore, openNotebookTestFile } from './ipynb-app-store-test-fixture'
import { useIpynbDocument, useIpynbDocumentEditing } from './useIpynbDocumentEditing'

vi.mock('@/store', async () => ({
  useAppStore: (await import('./ipynb-app-store-test-fixture')).notebookTestAppStore
}))

function notebookContent(firstSource = 'a', secondSource = 'b'): string {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { language_info: { name: 'python' } },
    cells: [
      {
        id: 'a',
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: [firstSource]
      },
      {
        id: 'b',
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: [secondSource]
      }
    ]
  })
}

function draft(): string | undefined {
  return notebookTestAppStore.getState().editorDrafts['notebook-a']
}

function renderEditing(onDeactivateEditor = vi.fn()) {
  return renderHook(() => {
    const { document } = useIpynbDocument('notebook-a', notebookContent())
    const editing = useIpynbDocumentEditing({
      fileId: 'notebook-a',
      language: 'python',
      onDeactivateEditor
    })
    return { notebook: document ? parseIpynbDocumentView(document) : null, ...editing }
  })
}

describe('notebook document editing lifecycle', () => {
  const animationFrames = new Map<number, FrameRequestCallback>()
  let nextFrameId = 1

  beforeEach(() => {
    vi.useFakeTimers()
    animationFrames.clear()
    nextFrameId = 1
    notebookTestAppStore.setState({ openFiles: [] })
    openNotebookTestFile('notebook-a')
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        const frameId = nextFrameId
        nextFrameId += 1
        animationFrames.set(frameId, callback)
        return frameId
      })
    )
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((frameId: number) => {
        animationFrames.delete(frameId)
      })
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('shows typing at once, writes the draft after a pause, and flushes the latest source', () => {
    const hook = renderEditing()

    act(() => {
      hook.result.current.updateCellSource(0, 'first draft')
      hook.result.current.updateCellSource(0, 'latest draft')
      vi.advanceTimersByTime(399)
    })
    expect(hook.result.current.notebook?.cells[0]?.source).toBe('latest draft')
    expect(notebookTestAppStore.getState().openFiles[0]?.isDirty).toBe(true)
    expect(draft()).toBeUndefined()

    act(() => flushPendingEditorChange('notebook-a'))
    expect(parseIpynb(draft() ?? '').cells[0]?.source).toBe('latest draft')

    act(() => {
      hook.result.current.updateCellSource(1, 'typed later')
      vi.advanceTimersByTime(400)
    })
    expect(parseIpynb(draft() ?? '').cells[1]?.source).toBe('typed later')
  })

  it('applies structural work on the next frame and cancels queued work on detach', () => {
    const onDeactivateEditor = vi.fn()
    const { result } = renderEditing(onDeactivateEditor)

    act(() => {
      result.current.updateCellSource(0, 'edited before move')
      result.current.moveCell(0, 1)
    })
    expect(onDeactivateEditor).toHaveBeenCalledOnce()
    expect(animationFrames.size).toBe(1)

    const [[frameId, frameCallback]] = [...animationFrames.entries()]
    animationFrames.delete(frameId)
    act(() => frameCallback(0))
    const movedNotebook = parseIpynb(draft() ?? '')
    expect(movedNotebook.cells.map((cell) => cell.id)).toEqual(['b', 'a'])
    expect(movedNotebook.cells[1]?.source).toBe('edited before move')

    act(() => result.current.deleteCell(0))
    expect(animationFrames.size).toBe(1)
    act(() => result.current.setRootRef(null))
    expect(cancelAnimationFrame).toHaveBeenCalled()
    expect(animationFrames.size).toBe(0)
  })
})
