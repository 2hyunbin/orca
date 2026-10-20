import React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { HostRowIcon } from '@/components/host-row-icon'
import type { ProjectHeaderHostContext } from './project-header-host-context'

export function ProjectHeaderHostLabel({
  context
}: {
  context: ProjectHeaderHostContext
}): React.JSX.Element {
  return (
    <span className="flex min-w-0 max-w-1/2 shrink-0 items-center gap-1 text-xs font-normal leading-4 text-muted-foreground">
      <HostRowIcon hostId={context.hostId} className="size-3.5 shrink-0" />
      <span className="truncate">{context.label}</span>
    </span>
  )
}

export function ProjectHeaderHostTooltip({
  context,
  label,
  children
}: {
  context: ProjectHeaderHostContext | undefined
  label: string
  children: React.JSX.Element
}): React.JSX.Element {
  if (!context) {
    return children
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side="right"
        sideOffset={8}
        className="max-w-80 whitespace-normal break-all text-left"
      >
        {label} — {context.label}
        {context.detail !== context.label ? <div>{context.detail}</div> : null}
      </TooltipContent>
    </Tooltip>
  )
}
