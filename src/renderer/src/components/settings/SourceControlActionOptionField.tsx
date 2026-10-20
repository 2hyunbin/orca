import type { ReactNode } from 'react'
import { Label } from '../ui/label'
import { SelectTrigger, SelectValue } from '../ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

export function SourceControlActionOptionField({
  label,
  children
}: {
  label: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="min-h-[56.5px] min-w-0 space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  )
}

export function SourceControlActionOptionsPlaceholder(): React.JSX.Element {
  return (
    <div aria-hidden="true">
      <SourceControlActionOptionField label={'\u00a0'}>
        <div className="h-8 rounded-md border border-border bg-muted/40" />
      </SourceControlActionOptionField>
    </div>
  )
}

export function SourceControlActionOptionTrigger({
  label,
  disabled
}: {
  label: string
  disabled?: boolean
}): React.JSX.Element {
  const trigger = (
    <SelectTrigger size="sm" className="h-8 w-full min-w-0" aria-label={label}>
      <SelectValue className="min-w-0 flex-1">
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      </SelectValue>
    </SelectTrigger>
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {disabled ? <span className="flex min-w-0">{trigger}</span> : trigger}
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
