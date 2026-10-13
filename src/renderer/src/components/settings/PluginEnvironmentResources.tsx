import type {
  EnvironmentRecipeAction,
  EnvironmentRecipeResource
} from '../../../../shared/environment-recipe-protocol'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'

export function PluginEnvironmentResources({
  resources,
  actions,
  blocked,
  blockedResourceIds,
  ready,
  onAction,
  onConnect
}: {
  resources: EnvironmentRecipeResource[]
  actions: EnvironmentRecipeAction[]
  blocked: boolean
  blockedResourceIds?: string[]
  ready: boolean
  onConnect?(resource: EnvironmentRecipeResource): void
  onAction(action: EnvironmentRecipeAction, resource: EnvironmentRecipeResource): void
}): React.JSX.Element {
  return (
    <>
      {resources.map((resource) => (
        <div
          key={resource.id}
          data-environment-resource-id={resource.id}
          data-environment-state={resource.state}
          className="space-y-2 border-t border-border pt-3"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-sm font-medium">{resource.name}</p>
              <p className="break-words font-mono text-xs text-muted-foreground">{resource.id}</p>
            </div>
            <p className="text-xs text-muted-foreground">
              {resource.lifetime} · {resource.state}
            </p>
          </div>
          {ready && resource.state !== 'deleted' ? (
            <div className="flex flex-wrap gap-2">
              {onConnect && resource.state === 'running' && resource.connection ? (
                <Button
                  size="xs"
                  disabled={blocked || Boolean(blockedResourceIds?.includes(resource.id))}
                  onClick={() => onConnect(resource)}
                >
                  {translate(
                    'auto.components.settings.PluginEnvironmentResources.connect',
                    'Connect'
                  )}
                </Button>
              ) : null}
              {actions.includes('sleep') && resource.state === 'running' ? (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={blocked || Boolean(blockedResourceIds?.includes(resource.id))}
                  onClick={() => onAction('sleep', resource)}
                >
                  {translate(
                    'auto.components.settings.PluginEnvironmentProviderCard.sleep',
                    'Sleep'
                  )}
                </Button>
              ) : null}
              {actions.includes('resume') &&
              (resource.state === 'sleeping' || resource.state === 'archived') ? (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={blocked || Boolean(blockedResourceIds?.includes(resource.id))}
                  onClick={() => onAction('resume', resource)}
                >
                  {translate('auto.components.settings.PluginEnvironmentProviderCard.wake', 'Wake')}
                </Button>
              ) : null}
              {actions.includes('archive') && resource.state !== 'archived' ? (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={blocked || Boolean(blockedResourceIds?.includes(resource.id))}
                  onClick={() => onAction('archive', resource)}
                >
                  {translate(
                    'auto.components.settings.PluginEnvironmentProviderCard.archive',
                    'Archive'
                  )}
                </Button>
              ) : null}
              {actions.includes('delete') ? (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={blocked || Boolean(blockedResourceIds?.includes(resource.id))}
                  onClick={() => onAction('delete', resource)}
                >
                  {translate(
                    'auto.components.settings.PluginEnvironmentProviderCard.delete',
                    'Delete'
                  )}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
    </>
  )
}
