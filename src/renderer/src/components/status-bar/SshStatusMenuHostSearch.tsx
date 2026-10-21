import { useId, useState, type RefObject } from 'react'
import { Input } from '@/components/ui/input'
import { canConnectSshStatus } from '@/ssh/ssh-connection-recoverability'
import type { SshStatusMenuTarget } from './ssh-status-menu-rows'
import {
  moreSshHostsLabel,
  noMatchingSshHostsLabel,
  searchSshHostsLabel
} from './ssh-status-segment-copy'
import { connectSshTargetFromStatusMenu, SshTargetStatusRow } from './SshTargetStatusRow'

/**
 * The hosts menu's not-connected SSH rows. Past the idle cap they become the results of a search
 * box that keeps focus while arrows move the active result and Enter connects it, because the rows
 * are not menu items the menu's own arrow keys can reach.
 */
export function SshStatusMenuHostSearch({
  rows,
  searchable,
  query,
  onQueryChange,
  hiddenIdleCount,
  idleMatched,
  inputRef
}: {
  rows: readonly SshStatusMenuTarget[]
  searchable: boolean
  query: string
  onQueryChange: (query: string) => void
  hiddenIdleCount: number
  idleMatched: boolean
  inputRef: RefObject<HTMLInputElement | null>
}): React.JSX.Element {
  const listboxId = useId()
  const [activeIndex, setActiveIndex] = useState(0)
  // Why connectable only: Enter connects the active result, and a host mid-connect can't take it.
  const options = searchable ? rows.filter((row) => canConnectSshStatus(row.status)) : []
  const active = options[Math.min(activeIndex, options.length - 1)]
  const optionId = (targetId: string): string => `${listboxId}-${targetId}`

  const hostRows = rows.map((row) => (
    <SshTargetStatusRow
      key={row.id}
      targetId={row.id}
      label={row.label}
      status={row.status}
      optionId={options.includes(row) ? optionId(row.id) : undefined}
      active={row === active}
    />
  ))

  return (
    <>
      {searchable ? (
        <div className="p-1">
          <Input
            ref={inputRef}
            role="combobox"
            aria-expanded
            aria-controls={listboxId}
            aria-activedescendant={active ? optionId(active.id) : undefined}
            value={query}
            onChange={(event) => {
              onQueryChange(event.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                event.stopPropagation()
                const step = event.key === 'ArrowDown' ? 1 : -1
                const current = Math.min(activeIndex, options.length - 1)
                setActiveIndex(Math.max(0, Math.min(options.length - 1, current + step)))
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                if (active) {
                  void connectSshTargetFromStatusMenu(active.id)
                }
                return
              }
              // Why: keep typed letters out of the menu's typeahead; Escape still closes it.
              if (event.key !== 'Escape' && event.key !== 'Tab') {
                event.stopPropagation()
              }
            }}
            onPointerDown={(event) => event.stopPropagation()}
            placeholder={searchSshHostsLabel()}
            aria-label={searchSshHostsLabel()}
            className="h-7 px-2 text-xs"
          />
        </div>
      ) : null}
      {searchable ? (
        <div id={listboxId} role="listbox" aria-label={searchSshHostsLabel()}>
          {hostRows}
        </div>
      ) : (
        hostRows
      )}
      {hiddenIdleCount > 0 ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          {moreSshHostsLabel(hiddenIdleCount)}
        </div>
      ) : query !== '' && !idleMatched ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">{noMatchingSshHostsLabel()}</div>
      ) : null}
    </>
  )
}
