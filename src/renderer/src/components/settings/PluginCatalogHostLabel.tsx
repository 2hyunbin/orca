import { translate } from '@/i18n/i18n'
import { usePluginCatalogHost } from './plugin-catalog-host-context'

export function PluginCatalogHostLabel(): React.JSX.Element | null {
  const host = usePluginCatalogHost()
  return host ? (
    <p className="text-xs text-muted-foreground">
      {translate(
        'auto.components.settings.PluginCatalogHostSection.managing',
        'Managing plugins on {{host}}',
        { host: host.hostLabel }
      )}
    </p>
  ) : null
}
