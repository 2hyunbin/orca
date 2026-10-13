import type { EnvironmentRecipeResource } from '../../../../shared/environment-recipe-protocol'
import { translate } from '@/i18n/i18n'
export function PluginEnvironmentMigrationInventory({
  resources
}: {
  resources: EnvironmentRecipeResource[]
}): React.JSX.Element {
  return (
    <div className="space-y-3">
      {resources.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {translate(
            'auto.components.settings.PluginEnvironmentMigrationInventory.empty',
            'This account returned no machines. Previous history is kept; absence does not prove deletion.'
          )}
        </p>
      ) : null}
      {resources.map((resource) => (
        <div key={resource.id} className="space-y-1 border-t border-border pt-3">
          <p className="text-sm font-medium">{resource.name}</p>
          <p className="break-words font-mono text-xs text-muted-foreground">
            {resource.id} · {resource.revision}
          </p>
          <p className="text-xs text-muted-foreground">
            {resource.lifetime} · {resource.state}
          </p>
          {resource.connection ? (
            <p className="break-words font-mono text-xs text-muted-foreground">
              {resource.connection.username}@{resource.connection.host}:{resource.connection.port}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  )
}
