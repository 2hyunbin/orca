import type { SourceControlActionLaunchPreferences } from '../../../../shared/source-control-ai-actions'
import {
  sourceControlActionAgentPicksModel,
  sourceControlActionChatOptions,
  sourceControlActionPermissionModes
} from '../../../../shared/source-control-action-launch-preferences'
import { Label } from '../ui/label'

export function SourceControlActionOptionsPlaceholder({
  value
}: {
  value?: SourceControlActionLaunchPreferences
}): React.JSX.Element {
  // Unknown agent: Model and Permissions, one row like most agents.
  const count = value
    ? (sourceControlActionAgentPicksModel(value.agentId)
        ? 1 + (value.model ? sourceControlActionChatOptions(value.agentId, value.model).length : 0)
        : 0) + (sourceControlActionPermissionModes(value.agentId).length > 0 ? 1 : 0)
    : 2
  return (
    <div aria-hidden="true" className="grid auto-rows-[minmax(56.5px,auto)] grid-cols-2 gap-2">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="space-y-2">
          <Label>{'\u00a0'}</Label>
          <div className="h-8 rounded-md border border-border bg-muted/40" />
        </div>
      ))}
    </div>
  )
}
