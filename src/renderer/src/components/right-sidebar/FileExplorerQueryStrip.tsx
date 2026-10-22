import React from 'react'
import { FileExplorerViewSwitch } from './FileExplorerViewSwitch'
import type { RightSidebarExplorerView } from '../../../../shared/ui-chrome-types'

type FileExplorerQueryStripProps = {
  view: RightSidebarExplorerView
  onSelectView: (view: RightSidebarExplorerView) => void
  children: React.ReactNode
}

export function FileExplorerQueryStrip({
  view,
  onSelectView,
  children
}: FileExplorerQueryStripProps): React.JSX.Element {
  return (
    <div className="border-b border-border px-2 py-2">
      <div className="flex flex-col gap-2">
        <FileExplorerViewSwitch view={view} onSelectView={onSelectView} />
        {children}
      </div>
    </div>
  )
}
