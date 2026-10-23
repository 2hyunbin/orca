import React, { useId } from 'react'
import { ChevronDown, Workflow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { getWorktreeStatusLabel, type WorktreeStatus } from '@/lib/worktree-status'
import { cn } from '@/lib/utils'
import StatusIndicator from './StatusIndicator'
import { useWorktreeActivityStatuses } from './use-worktree-activity-statuses'

const EMPTY_CHILD_IDS: readonly string[] = []
const STATUS_ORDER: readonly WorktreeStatus[] = [
  'permission',
  'failed',
  'unconfirmed',
  'working',
  'monitoring',
  'interrupted',
  'done',
  'active',
  'inactive'
]

export function WorktreeLineageToggle({
  childWorktreeIds = EMPTY_CHILD_IDS,
  collapsed,
  ariaLabel,
  label,
  newCardStyle,
  onToggle
}: {
  childWorktreeIds?: readonly string[]
  collapsed: boolean
  ariaLabel: string
  label: string
  newCardStyle: boolean
  onToggle?: React.MouseEventHandler<HTMLButtonElement>
}): React.JSX.Element {
  const descriptionId = useId()
  const statuses = useWorktreeActivityStatuses(childWorktreeIds)
  const counts = new Map<WorktreeStatus, number>()
  for (const status of statuses.values()) {
    counts.set(status, (counts.get(status) ?? 0) + 1)
  }
  const summary = STATUS_ORDER.filter((status) => counts.has(status))
  const description = summary
    .map((status) => `${counts.get(status)} ${getWorktreeStatusLabel(status)}`)
    .join(', ')

  return (
    <div className={cn('relative mt-1 flex min-w-0 justify-start', !newCardStyle && '-ml-1')}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="chip"
            className="relative z-10 h-auto min-h-4.5 max-w-full"
            aria-label={ariaLabel}
            aria-describedby={description ? descriptionId : undefined}
            aria-expanded={!collapsed}
            onClick={onToggle}
          >
            <span className="inline-flex min-w-0 items-center gap-2 px-1 py-0.5">
              <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="inline-flex shrink-0 items-center gap-1">
                  <Workflow className="size-2.5 shrink-0" />
                  <span className="truncate">{label}</span>
                </span>
                {summary.length > 0 ? (
                  <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-l border-border pl-2">
                    {summary.map((status) => (
                      <span
                        key={status}
                        className="inline-flex shrink-0 items-center gap-0.5 tabular-nums"
                        data-child-worktree-status={status}
                        aria-hidden="true"
                      >
                        <StatusIndicator status={status} showTooltip={false} />
                        {counts.get(status)}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
              <ChevronDown
                className={cn('size-2.5 shrink-0 transition-transform', collapsed && '-rotate-90')}
              />
            </span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {collapsed
            ? translate('auto.components.sidebar.WorktreeCard.8cb634cda6', 'Show child workspaces')
            : translate('auto.components.sidebar.WorktreeCard.57eaa61b55', 'Hide child workspaces')}
          {description ? <div>{description}</div> : null}
        </TooltipContent>
      </Tooltip>
      {description ? (
        <span id={descriptionId} className="sr-only">
          {description}
        </span>
      ) : null}
    </div>
  )
}
