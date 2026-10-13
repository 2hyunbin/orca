import { useRef } from 'react'
import { copyPluginViewerCellValue } from './plugin-viewer-selection-copy'
import { Button } from '../components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover'
import { Textarea } from '../components/ui/textarea'
import type { PluginViewerChrome } from '../../../shared/plugins/plugin-viewer-frame-protocol'

export type ViewerInspectedCell = { name: string; text: string; cached: boolean }

export function PluginViewerCellInspection({
  cell,
  open,
  ready,
  labels,
  setOpen,
  restoreFocus,
  copySelection
}: {
  cell: ViewerInspectedCell
  open: boolean
  ready: boolean
  labels: PluginViewerChrome['labels']
  setOpen(open: boolean): void
  restoreFocus(): void
  copySelection(): Promise<boolean>
}): React.JSX.Element {
  const value = useRef<HTMLTextAreaElement>(null)
  const select = (): void => {
    value.current?.focus()
    value.current?.select()
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" disabled={!ready}>
          {labels.cellDetails ?? 'Cell details'}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-96 max-w-[calc(100vw-2rem)]"
        aria-label={`${labels.cellValue ?? 'Cell value'} ${cell.name}`}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          select()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          restoreFocus()
        }}
      >
        <div className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">{cell.name}</span>
            <Button variant="ghost" size="xs" onClick={() => setOpen(false)}>
              {labels.close ?? 'Close'}
            </Button>
          </div>
          {cell.cached && <p className="text-xs text-muted-foreground">{labels.cachedFormula}</p>}
          <Textarea
            ref={value}
            readOnly
            value={cell.text}
            aria-label={labels.cellValue ?? 'Cell value'}
            className="h-40 resize-none"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              select()
              void copyPluginViewerCellValue(cell.text, copySelection, labels)
            }}
          >
            {labels.copy ?? 'Copy value'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
