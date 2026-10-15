import { memo, type Dispatch, type SetStateAction } from 'react'
import { IpynbCellToolbar } from './IpynbCellToolbar'
import { IpynbCellSource } from './IpynbCellEditor'
import { IpynbCellOutputs } from './IpynbCellOutputs'
import { IpynbCellRunPrompt } from './IpynbCellRun'
import type { IpynbCell, IpynbCellKind } from './ipynb-parse'

type IpynbCellRowProps = {
  cell: IpynbCell
  index: number
  cellKey: string
  filePath: string
  active: boolean
  isLast: boolean
  setEditingCellKey: Dispatch<SetStateAction<string | null>>
  onKeyDownCapture: (event: React.KeyboardEvent<HTMLElement>, index: number) => void
  runCell: (index: number) => void
  updateCellSource: (index: number, source: string) => void
  updateCellKind: (index: number, kind: IpynbCellKind) => void
  insertCell: (index: number, kind: IpynbCellKind) => void
  moveCell: (index: number, direction: -1 | 1) => void
  deleteCell: (index: number) => void
}

// Why memo: output streams into one cell's document record; the other cells keep their objects.
export const IpynbCellRow = memo(function IpynbCellRow({
  cell,
  index,
  cellKey,
  filePath,
  active,
  isLast,
  setEditingCellKey,
  onKeyDownCapture,
  runCell,
  updateCellSource,
  updateCellKind,
  insertCell,
  moveCell,
  deleteCell
}: IpynbCellRowProps): React.JSX.Element {
  return (
    <section
      className="group relative flex gap-2 py-1.5"
      onKeyDownCapture={(event) => onKeyDownCapture(event, index)}
    >
      {/* Mirrors the code surface's border and padding so the count shares the first line's box. */}
      <div className="flex w-12 shrink-0 justify-center border-y border-transparent py-1">
        {cell.kind === 'code' ? (
          <IpynbCellRunPrompt
            filePath={filePath}
            cellKey={cellKey}
            executionCount={cell.executionCount}
            onRun={() => runCell(index)}
          />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <IpynbCellSource
          cell={cell}
          source={cell.source}
          active={active}
          onActivate={() => setEditingCellKey(cellKey)}
          onDeactivate={() =>
            setEditingCellKey((current) => (current === cellKey ? null : current))
          }
          onChange={(nextSource) => updateCellSource(index, nextSource)}
        />
        <IpynbCellOutputs cell={cell} />
      </div>
      <IpynbCellToolbar
        kind={cell.kind}
        canMoveUp={index > 0}
        canMoveDown={!isLast}
        onKindChange={(kind) => updateCellKind(index, kind)}
        onInsert={(offset, kind) => insertCell(index + offset, kind)}
        onMove={(direction) => moveCell(index, direction)}
        onDelete={() => deleteCell(index)}
      />
    </section>
  )
})
