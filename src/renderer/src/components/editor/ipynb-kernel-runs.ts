import { toast } from 'sonner'
import type { KernelOutputType } from '../../../../shared/notebook-kernel-types'
import { updateNotebookCellRun, writeNotebookDraft } from './ipynb-document-store'
import { applyKernelOutput, noticeOutput, type NotebookOutput } from './ipynb-kernel-outputs'
import {
  getSession,
  runningCellKey,
  updateSession,
  type CellRun,
  type NotebookKernelSession
} from './ipynb-kernel-store'

export function startRun(fileId: string): CellRun {
  return {
    fileId,
    clearOnNextOutput: false,
    executionCount: null,
    startedAt: Date.now(),
    finishedAt: null
  }
}

/** Ends the executing run, if any, and drops every queued cell. */
function stopRuns(session: NotebookKernelSession) {
  const key = runningCellKey(session)
  const run = key === null ? null : session.runs[key]
  return {
    queue: [],
    interruptStalled: false,
    runs:
      key === null || !run
        ? session.runs
        : { ...session.runs, [key]: { ...run, finishedAt: Date.now() } }
  }
}

/** Stops the session's runs; the executing run's outputs, plus `notice`, join the notebook's draft. */
export function endRun(filePath: string, notice?: NotebookOutput): void {
  const session = getSession(filePath)
  const key = runningCellKey(session)
  const run = key === null ? undefined : session.runs[key]
  updateSession(filePath, stopRuns)
  if (key !== null && run) {
    if (notice) {
      updateNotebookCellRun(run.fileId, key, {
        outputs: (outputs) => [...outputs, notice]
      })
    }
    writeNotebookDraft(run.fileId)
  }
}

/** Writes a run's output frames into its notebook's document as one change. */
export function applyOutputFrames(
  filePath: string,
  key: string,
  frames: { type: KernelOutputType; content: Record<string, unknown> }[]
): void {
  const run = getSession(filePath).runs[key]
  if (!run) {
    return
  }
  let { clearOnNextOutput } = run
  updateNotebookCellRun(run.fileId, key, {
    outputs: (outputs) => {
      const live = frames.reduce(
        (next, frame) => applyKernelOutput(next, frame.type, frame.content),
        { outputs, clearOnNextOutput }
      )
      clearOnNextOutput = live.clearOnNextOutput
      return live.outputs
    }
  })
  if (clearOnNextOutput !== run.clearOnNextOutput) {
    updateSession(filePath, ({ runs }) => ({
      runs: { ...runs, [key]: { ...(runs[key] ?? run), clearOnNextOutput } }
    }))
  }
}

/** Reports a failure in the first queued cell (a toast when nothing was queued) and drops the queue. */
export function failQueue(filePath: string, message: string, detail = ''): void {
  const [head] = getSession(filePath).queue
  if (!head) {
    toast.error(message, { description: detail.slice(-500) })
  }
  updateSession(filePath, ({ runs }) => ({
    status: 'off',
    queue: [],
    setup: null,
    runs: head
      ? {
          ...runs,
          [head.key]: { ...startRun(head.fileId), finishedAt: Date.now() }
        }
      : runs
  }))
  if (head) {
    const notice = noticeOutput(message + fenced(detail))
    updateNotebookCellRun(head.fileId, head.key, {
      outputs: () => [notice],
      executionCount: null
    })
    writeNotebookDraft(head.fileId)
  }
}

export function fenced(text: string): string {
  return text ? `\n\n\`\`\`\n${text}\n\`\`\`` : ''
}
