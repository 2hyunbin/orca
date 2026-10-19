import type { SourceControlActionLaunchPreferences } from '../../../../shared/source-control-ai-actions'
import { sourceControlActionChatOptions } from '../../../../shared/source-control-action-launch-preferences'
import { Label } from '../ui/label'

export function SourceControlActionOptionsPlaceholder({
  value
}: {
  value?: SourceControlActionLaunchPreferences
}): React.JSX.Element {
  const count = value ? 1 + sourceControlActionChatOptions(value.agentId, value.model).length : 1
  return (
    <div aria-hidden="true" className="grid grid-cols-2 gap-2">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="space-y-2">
          <Label>&nbsp;</Label>
          <div className="h-8 rounded-md border border-border bg-muted/40" />
        </div>
      ))}
    </div>
  )
}
