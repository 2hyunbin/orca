import { PluginLanguageAction } from '../settings/PluginLanguageAction'
import { pluginStatusPresentation } from '../settings/plugin-status-presentation'
import { useState } from 'react'
import { Copy, Loader2 } from 'lucide-react'
import type {
  PluginHostListEntry,
  PluginMarketplaceHostListing
} from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { PluginCatalogAvatar } from './PluginCatalogAvatar'
import { PluginCatalogPreview } from './PluginCatalogPreview'
import { pluginDisplayNameFromKey } from './plugin-display-name'
import { pluginExecutionDescription } from './plugin-catalog-labels'

type Props = {
  listing: PluginMarketplaceHostListing
  installed: PluginHostListEntry | null
  busy: boolean
  onPreview: (listing: PluginMarketplaceHostListing, update: boolean) => void
}

export function PluginCatalogDetail({
  listing,
  installed,
  busy,
  onPreview
}: Props): React.JSX.Element {
  const [copyError, setCopyError] = useState(false)
  const [copied, setCopied] = useState(false)
  const name = listing.name ?? pluginDisplayNameFromKey(listing.pluginKey)
  const release = listing.release
  const blocked = listing.blockedByKillList
  const source = `${listing.source.url}#${listing.source.ref}`
  const update = installed?.source?.kind === 'marketplace'
  const copySource = async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(source)
      setCopied(true)
      setCopyError(false)
    } catch {
      setCopyError(true)
    }
  }
  return (
    <div className="space-y-5" data-plugin-detail={listing.pluginKey}>
      <div className="flex items-start gap-3">
        <PluginCatalogAvatar name={name} />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{name}</h3>
          <p className="mt-1 break-all text-xs text-muted-foreground">{listing.pluginKey}</p>
          <Badge variant="outline" className="mt-2">
            {listing.bundled
              ? translate(
                  'auto.components.settings.PluginCatalogDetail.bundled',
                  'Bundled with Orca'
                )
              : listing.official
                ? translate(
                    'auto.components.settings.PluginCatalogDetail.official',
                    'Official publisher'
                  )
                : translate(
                    'auto.components.settings.PluginCatalogDetail.community',
                    'Community publisher'
                  )}
          </Badge>
        </div>
      </div>
      <p className="text-sm leading-6">
        {listing.description ??
          translate(
            'auto.components.settings.PluginCatalogDetail.noDescription',
            'No description provided.'
          )}
      </p>
      {release?.preview ? (
        <PluginCatalogPreview
          preview={release.preview}
          label={translate('plugins.catalog.publisherPreview', 'Publisher preview')}
        />
      ) : null}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
        <dt className="text-muted-foreground">
          {translate('auto.components.settings.PluginCatalogDetail.version', 'Version')}
        </dt>
        <dd>
          {release?.version ??
            translate(
              'auto.components.settings.PluginCatalogDetail.checkedAtInstall',
              'Checked at install'
            )}
        </dd>
        {release ? (
          <>
            <dt className="text-muted-foreground">
              {translate(
                'auto.components.settings.PluginCatalogDetail.compatibility',
                'Requires Orca'
              )}
            </dt>
            <dd>{release.minimumOrca}+</dd>
            <dt className="text-muted-foreground">
              {translate('auto.components.settings.PluginCatalogDetail.license', 'License')}
            </dt>
            <dd>{release.license}</dd>
            <dt className="text-muted-foreground">
              {translate('auto.components.settings.PluginCatalogDetail.commit', 'Release commit')}
            </dt>
            <dd className="break-all font-mono">{release.commit}</dd>
            <dt className="text-muted-foreground">
              {translate('plugins.catalog.releaseHash', 'Package SHA-256')}
            </dt>
            <dd className="break-all font-mono">{release.contentHash}</dd>
          </>
        ) : null}
        {installed ? (
          <>
            <dt className="text-muted-foreground">
              {translate(
                'auto.components.settings.PluginCatalogDetail.installedVersion',
                'Installed version'
              )}
            </dt>
            <dd>{installed.version}</dd>
            <dt className="text-muted-foreground">
              {translate('auto.components.settings.PluginCatalogDetail.state', 'State')}
            </dt>
            <dd>{pluginStatusPresentation(installed).label}</dd>
          </>
        ) : null}
      </dl>
      <div className="plugin-security-chrome space-y-2 border-t pt-4">
        <p className="text-xs font-semibold">
          {translate(
            'auto.components.settings.PluginCatalogDetail.execution',
            'Declared execution'
          )}
        </p>
        <p className="text-xs leading-5 text-muted-foreground">
          {release
            ? pluginExecutionDescription(release.execution)
            : translate(
                'auto.components.settings.PluginCatalogDetail.legacyDescription',
                'Legacy package. Orca checks its executable content and permissions during review.'
              )}
        </p>
        {release ? (
          <p className="text-xs leading-5 text-muted-foreground">
            {translate(
              'auto.components.settings.PluginCatalogDetail.releaseChecks',
              'Orca checks the release commit, file hash and execution profile before installation.'
            )}
          </p>
        ) : null}
      </div>
      {blocked ? (
        <p role="alert" className="plugin-security-chrome text-xs text-destructive">
          {blocked.reason}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {installed && !blocked ? (
          <PluginLanguageAction pluginKey={listing.pluginKey} disabled={busy} />
        ) : null}
        {!installed || update ? (
          <Button
            size="sm"
            disabled={busy || Boolean(blocked)}
            onClick={() => onPreview(listing, Boolean(update))}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {update
              ? listing.release?.execution === 'data' &&
                window.api.plugins.installMarketplaceDataPlugin
                ? translate('auto.components.settings.PluginMarketplaceListingRow.update', 'Update')
                : translate(
                    'auto.components.settings.PluginCatalogDetail.reviewUpdate',
                    'Review update'
                  )
              : translate('auto.components.settings.PluginCatalogDetail.install', 'Install')}
          </Button>
        ) : (
          <Badge variant="secondary">
            {translate('auto.components.settings.PluginCatalogDetail.installed', 'Installed')}
          </Badge>
        )}
        <Button variant="outline" size="sm" onClick={() => void copySource()}>
          <Copy />
          {copied
            ? translate('auto.components.settings.PluginCatalogDetail.copied', 'Copied')
            : translate('auto.components.settings.PluginCatalogDetail.copySource', 'Copy source')}
        </Button>
      </div>
      <p className="break-all font-mono text-[11px] text-muted-foreground">{source}</p>
      {copyError ? (
        <p role="alert" className="text-xs text-destructive">
          {translate(
            'auto.components.settings.PluginCatalogDetail.copyFailed',
            'Could not copy. Select the source above to copy it manually.'
          )}
        </p>
      ) : null}
    </div>
  )
}
