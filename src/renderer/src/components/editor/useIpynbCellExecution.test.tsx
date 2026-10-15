// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseIpynbDocumentView } from './ipynb-parse'
import type { KernelFrameEvent } from '../../../../shared/notebook-kernel-types'

const { getConnectionIdMock, notebookApi, toastError } = vi.hoisted(() => {
  const notebookApi = {
    listPythonEnvironments: vi.fn(),
    startKernel: vi.fn(),
    execute: vi.fn(),
    shutdownKernel: vi.fn(),
    onKernelFrame: vi.fn((_listener: (event: KernelFrameEvent) => void) => () => {})
  }
  // The kernel session subscribes to kernel frames when it loads.
  Object.defineProperty(window, 'api', { configurable: true, value: { notebook: notebookApi } })
  return {
    getConnectionIdMock: vi.fn((): string | null => null),
    notebookApi,
    toastError: vi.fn()
  }
})

vi.mock('@/lib/connection-context', () => ({ getConnectionId: getConnectionIdMock }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/store', async () => ({
  useAppStore: (await import('./ipynb-app-store-test-fixture')).notebookTestAppStore
}))

import { useIpynbCellExecution } from './useIpynbCellExecution'
import { getNotebookDocumentView, openNotebookDocument } from './ipynb-document-store'
import { notebookTestAppStore, openNotebookTestFile } from './ipynb-app-store-test-fixture'

function notebookContent(withIds: boolean): string {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: withIds ? 5 : 4,
    metadata: { language_info: { name: 'python' } },
    cells: [
      { ...(withIds ? { id: 'md' } : {}), cell_type: 'markdown', metadata: {}, source: ['# hi'] },
      {
        ...(withIds ? { id: 'run' } : {}),
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: ['print(42)']
      }
    ]
  })
}

function renderExecution(filePath: string, withIds = true) {
  notebookTestAppStore.setState({ openFiles: [] })
  openNotebookTestFile('notebook', filePath)
  openNotebookDocument('notebook', notebookContent(withIds))
  const hook = renderHook(() =>
    useIpynbCellExecution({
      fileId: 'notebook',
      filePath,
      worktreeId: 'worktree-a',
      rootPath: '/repo'
    })
  )
  const cells = () => {
    const document = getNotebookDocumentView('notebook')?.document
    return document ? parseIpynbDocumentView(document).cells : []
  }
  return { hook, cells }
}

beforeEach(() => {
  vi.clearAllMocks()
  getConnectionIdMock.mockReturnValue(null)
  notebookApi.listPythonEnvironments.mockResolvedValue({
    workspace: [{ path: '/repo/.venv/bin/python', name: '.venv', version: '3.12.1' }],
    path: []
  })
  notebookApi.startKernel.mockResolvedValue({ status: 'ready' })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('notebook cell execution', () => {
  it('asks for trust before running, then runs the cell in a kernel', async () => {
    const { hook } = renderExecution('/repo/trust.ipynb')

    act(() => hook.result.current.runCell(1))
    expect(hook.result.current.pendingRun).toEqual([
      { key: 'run', code: 'print(42)', fileId: 'notebook' }
    ])
    expect(notebookApi.startKernel).not.toHaveBeenCalled()

    act(() => hook.result.current.confirmPendingRun())
    await waitFor(() =>
      expect(notebookApi.execute).toHaveBeenCalledWith({
        filePath: '/repo/trust.ipynb',
        code: 'print(42)'
      })
    )
    expect(notebookApi.startKernel).toHaveBeenCalledWith({
      filePath: '/repo/trust.ipynb',
      python: '/repo/.venv/bin/python'
    })
  })

  it('refuses to run in SSH workspaces without touching the notebook or starting a kernel', () => {
    getConnectionIdMock.mockReturnValue('ssh-connection')
    const { hook } = renderExecution('/remote/notebook.ipynb', false)

    act(() => hook.result.current.runCell(1))
    expect(toastError).toHaveBeenCalledWith(
      'Notebook cells can only run for files on this computer.'
    )
    expect(notebookTestAppStore.getState().openFiles[0]?.isDirty).toBe(false)
    expect(hook.result.current.pendingRun).toBeNull()
    expect(notebookApi.startKernel).not.toHaveBeenCalled()
  })

  it('gives id-less cells ids before queueing, so output follows a moved cell', () => {
    const { hook, cells } = renderExecution('/repo/legacy.ipynb', false)

    act(() => hook.result.current.runCell(1))
    const [cell] = hook.result.current.pendingRun ?? []
    expect(cells()[1]?.id).toBeTruthy()
    expect(cell?.key).toBe(cells()[1]?.id)
  })
})
