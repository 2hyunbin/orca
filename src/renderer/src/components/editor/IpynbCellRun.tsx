import { formatToolDuration } from '../../../../shared/native-chat-tool-identity'
import { IpynbRunPrompt } from './IpynbCellToolbar'
import { useCellRun } from './ipynb-kernel-store'

/** The gutter for a code cell, reflecting its run in the notebook's kernel session. */
export function IpynbCellRunPrompt({
  filePath,
  cellKey,
  executionCount,
  onRun
}: {
  filePath: string
  cellKey: string
  executionCount: number | null
  onRun: () => void
}): React.JSX.Element {
  const { run, queued } = useCellRun(filePath, cellKey)
  return (
    <IpynbRunPrompt
      executionCount={executionCount}
      state={run?.finishedAt === null ? 'running' : queued ? 'queued' : 'idle'}
      // Only a kernel execution has a duration worth showing, not an Orca notice.
      duration={
        run?.finishedAt && run.executionCount !== null
          ? formatToolDuration(run.finishedAt - run.startedAt)
          : null
      }
      onRun={onRun}
    />
  )
}
