import { AlertTriangle, Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { PluginCatalogAvatar } from '../plugin-catalog/PluginCatalogAvatar'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { SettingsSwitch } from './SettingsFormControls'
import { PluginLanguageAction } from './PluginLanguageAction'
import type { useBundledDataState } from './use-bundled-data-state'

export function PluginIncludedDataSection({
  state
}: {
  state: ReturnType<typeof useBundledDataState>
}): React.JSX.Element | null {
  if (!state.available) {
    return null
  }
  return (
    <section
      className="mb-4 space-y-3"
      aria-label={translate(
        'auto.components.settings.PluginSettingsOverview.includedTitle',
        'Included with Orca'
      )}
    >
      <div>
        <h3 className="text-sm font-medium">
          {translate(
            'auto.components.settings.PluginSettingsOverview.includedTitle',
            'Included with Orca'
          )}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.PluginIncludedDataSection.description',
            'Language data works offline, even when optional plugins are off. Disable it here to use English or plain text.'
          )}
        </p>
      </div>
      {state.failed ? (
        <div
          className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-xs"
          role="alert"
        >
          <span>
            {translate(
              'auto.components.settings.PluginIncludedDataSection.failed',
              'Could not load or save included language data.'
            )}
          </span>
          <Button size="sm" variant="outline" onClick={() => void state.retry()}>
            {translate('auto.components.settings.PluginIncludedDataSection.retry', 'Retry')}
          </Button>
        </div>
      ) : null}
      {state.loading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {translate(
            'auto.components.settings.PluginIncludedDataSection.loading',
            'Loading included languages…'
          )}
        </p>
      ) : null}
      <div className="grid gap-3 lg:grid-cols-2">
        {state.packs.map((pack) => (
          <article
            key={pack.pluginKey}
            data-bundled-plugin-key={pack.pluginKey}
            className="flex min-h-36 flex-col rounded-xl border border-border/80 bg-card p-4 text-card-foreground shadow-xs"
          >
            <div className="flex items-start gap-3">
              <PluginCatalogAvatar name={pack.name} />
              <div className="min-w-0 flex-1">
                <h4 className="text-sm font-medium">
                  {pack.type === 'locale'
                    ? translate(
                        'auto.components.settings.PluginIncludedDataSection.spanish',
                        'Spanish'
                      )
                    : translate(
                        'auto.components.settings.PluginIncludedDataSection.typst',
                        'Typst syntax'
                      )}
                </h4>
                <p className="text-xs text-muted-foreground">
                  {pack.type === 'locale'
                    ? translate(
                        'auto.components.settings.PluginIncludedDataSection.interfaceLanguage',
                        'Interface language'
                      )
                    : translate(
                        'auto.components.settings.PluginIncludedDataSection.codingLanguage',
                        'Coding language · .typ'
                      )}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Badge variant="secondary">
                    {translate(
                      'auto.components.settings.PluginIncludedDataSection.dataOnly',
                      'Data only'
                    )}
                  </Badge>
                  <Badge variant="outline">
                    {pack.enabled
                      ? translate(
                          'auto.components.settings.PluginIncludedDataSection.enabled',
                          'Enabled'
                        )
                      : translate(
                          'auto.components.settings.PluginIncludedDataSection.disabled',
                          'Disabled'
                        )}
                  </Badge>
                </div>
              </div>
              <SettingsSwitch
                checked={pack.enabled}
                disabled={state.busy.has(pack.pluginKey)}
                ariaLabel={
                  pack.enabled
                    ? translate(
                        'auto.components.settings.PluginIncludedDataSection.disable',
                        'Disable included {{name}}',
                        { name: pack.name }
                      )
                    : translate(
                        'auto.components.settings.PluginIncludedDataSection.restore',
                        'Restore included {{name}}',
                        { name: pack.name }
                      )
                }
                onChange={() => void state.toggle(pack)}
              />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              {pack.source === 'installed'
                ? translate(
                    'auto.components.settings.PluginIncludedDataSection.installedVersion',
                    'Using approved installed v{{version}}. Orca’s v{{bundledVersion}} stays as a fallback.',
                    { version: pack.version, bundledVersion: pack.bundledVersion }
                  )
                : pack.enabled && !pack.unavailable
                  ? translate(
                      'auto.components.settings.PluginIncludedDataSection.bundledVersion',
                      'Included v{{version}} · no permissions to run code.',
                      { version: pack.bundledVersion }
                    )
                  : translate(
                      'auto.components.settings.PluginIncludedDataSection.fallback',
                      'Your language preference is kept. English or plain text is used until this is restored.'
                    )}
            </p>
            {pack.unavailable ? (
              <p className="mt-2 flex items-start gap-2 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                {translate(
                  'auto.components.settings.PluginIncludedDataSection.unavailable',
                  'Verified language data is unavailable. Retry loading, or keep using the fallback.'
                )}
                <Button size="sm" variant="ghost" onClick={() => void state.retry()}>
                  {translate('auto.components.settings.PluginIncludedDataSection.retry', 'Retry')}
                </Button>
              </p>
            ) : null}
            {pack.enabled && !pack.unavailable && pack.type === 'locale' ? (
              <div className="mt-auto flex justify-end pt-3">
                <PluginLanguageAction
                  pluginKey={pack.pluginKey}
                  disabled={state.busy.has(pack.pluginKey)}
                />
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  )
}
