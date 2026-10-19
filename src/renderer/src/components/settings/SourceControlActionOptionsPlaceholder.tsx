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
  // Unknown agent: Model and Permissions, as most agents show. Both take full rows, as loaded.
  const fullRows = value
    ? (sourceControlActionAgentPicksModel(value.agentId) ? 1 : 0) +
      (sourceControlActionPermissionModes(value.agentId).length > 0 ? 1 : 0)
    : 2
  const cells =
    value?.model && sourceControlActionAgentPicksModel(value.agentId)
      ? sourceControlActionChatOptions(value.agentId, value.model).length
      : 0
  return (
    <div aria-hidden="true" className="grid auto-rows-[minmax(56.5px,auto)] grid-cols-2 gap-2">
      {Array.from({ length: fullRows }, (_, index) => (
        <div key={`row-${index}`} className="col-span-2">
          <PlaceholderSlot />
        </div>
      ))}
      {Array.from({ length: cells }, (_, index) => (
        <PlaceholderSlot key={`cell-${index}`} />
      ))}
    </div>
  )
}

function PlaceholderSlot(): React.JSX.Element {
  return (
    <div className="space-y-2">
      <Label>{'\u00a0'}</Label>
      <div className="h-8 rounded-md border border-border bg-muted/40" />
    </div>
  )
}
