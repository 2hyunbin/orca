import { ChevronDown } from 'lucide-react'
import type { AgentPermissionMode } from '../../../../shared/tui-agent-permissions'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

export function AgentRowPermissionControl({
  label,
  mode,
  autoSupported,
  onChange
}: {
  label: string
  mode: AgentPermissionMode
  autoSupported: boolean
  onChange: (mode: Exclude<AgentPermissionMode, 'mixed'>) => void
}): React.JSX.Element {
  const options = [
    {
      value: 'manual',
      label: translate('auto.components.settings.AgentsPane.agentPermissionsManual', 'Manual')
    },
    ...(autoSupported
      ? [{ value: 'auto', label: translate('settings.agents.autoPermissions', 'Auto') }]
      : []),
    {
      value: 'yolo',
      label: translate('auto.components.settings.AgentsPane.agentPermissionsYolo', 'Yolo')
    }
  ] as const
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">
        {translate('settings.agents.rowPermissions', 'Permissions')}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={mode === 'mixed'}
            aria-label={translate('settings.agents.rowPermissionsLabel', '{{agent}} permissions', {
              agent: label
            })}
          >
            {mode === 'mixed'
              ? translate('settings.agents.customPermissions', 'Custom arguments')
              : options.find((option) => option.value === mode)?.label}
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup value={mode}>
            {options.map((option) => (
              <DropdownMenuRadioItem
                key={option.value}
                value={option.value}
                onSelect={() => {
                  if (
                    option.value === 'manual' ||
                    option.value === 'auto' ||
                    option.value === 'yolo'
                  ) {
                    onChange(option.value)
                  }
                }}
              >
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
