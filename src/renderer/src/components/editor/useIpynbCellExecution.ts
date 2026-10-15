import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getConnectionId } from '@/lib/connection-context'
import { clearIpynbOutputs, withIpynbCellIds } from './ipynb-cell-mutations'
import { editNotebookDocument, getNotebookDocumentView } from './ipynb-document-store'
import { forgetFinishedRuns, runCells, trustNotebook } from './ipynb-kernel-session'
import { getSession, type QueuedCell } from './ipynb-kernel-store'
import { parseIpynbDocumentView } from './ipynb-parse'
import { getIpynbCellKey } from './useIpynbDocumentEditing'

type UseIpynbCellExecutionArgs = {
  fileId: string
  filePath: string
  worktreeId: string
  /** The workspace root, where the search for a project `.venv` stops. */
  rootPath: string | null
}

export function useIpynbCellExecution({
  fileId,
  filePath,
  worktreeId,
  rootPath
}: UseIpynbCellExecutionArgs) {
  const [pendingRun, setPendingRun] = useState<QueuedCell[] | null>(null)

  const run = useCallback(
    (indexes: number[]): void => {
      const document = getNotebookDocumentView(fileId)?.document
      if (!document) {
        return
      }
      const notebook = parseIpynbDocumentView(document)
      const codeIndexes = indexes.filter((index) => notebook.cells[index]?.kind === 'code')
      if (codeIndexes.length === 0) {
        return
      }
      if (getConnectionId(worktreeId) || notebook.language !== 'python') {
        toast.error(
          getConnectionId(worktreeId)
            ? translate(
                'auto.components.editor.IpynbViewer.localOnly',
                'Notebook cells can only run for files on this computer.'
              )
            : translate(
                'auto.components.editor.IpynbViewer.pythonOnly',
                'Only Python notebooks can run in Orca.'
              )
        )
        return
      }
      // Why: id-less (nbformat 4.4) cells are keyed by index, so a move mid-run would misroute output.
      const withIds = withIpynbCellIds(document)
      if (withIds !== document) {
        editNotebookDocument(fileId, () => withIds, 'now')
      }
      const { cells } = parseIpynbDocumentView(withIds)
      const queued = codeIndexes.flatMap((index) => {
        const cell = cells[index]
        return cell ? [{ key: getIpynbCellKey(cell, index), code: cell.source, fileId }] : []
      })
      if (getSession(filePath).trusted) {
        void runCells(filePath, queued, rootPath)
      } else {
        setPendingRun(queued)
      }
    },
    [fileId, filePath, rootPath, worktreeId]
  )

  const runCell = useCallback((index: number) => run([index]), [run])

  const confirmPendingRun = (): void => {
    trustNotebook(filePath)
    setPendingRun(null)
    if (pendingRun) {
      void runCells(filePath, pendingRun, rootPath)
    }
  }

  const clearAllOutputs = (): void => {
    editNotebookDocument(fileId, clearIpynbOutputs, 'now')
    forgetFinishedRuns(filePath)
  }

  return {
    pendingRun,
    cancelPendingRun: () => setPendingRun(null),
    confirmPendingRun,
    runCell,
    runAll: (cellCount: number) => run([...Array(cellCount).keys()]),
    clearAllOutputs
  }
}
