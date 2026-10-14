import { usePluginCatalogApi } from './plugin-catalog-host-context'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Blocks, Loader2, RefreshCw, Settings2, Store } from 'lucide-react'
import type {
  PluginHostListEntry,
  PluginMarketplaceHostInstallPreview,
  PluginMarketplaceHostListing,
  PluginMarketplaceHostSourceState
} from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { PluginCatalogEmptyState } from '../plugin-catalog/PluginCatalogEmptyState'
import {
  PluginCatalogLayout,
  type PluginCatalogFilter
} from '../plugin-catalog/PluginCatalogLayout'
import { Button } from '../ui/button'
import { PluginCatalogResults } from '../plugin-catalog/PluginCatalogResults'
import {
  PluginMarketplacePreviewDialog,
  type PluginMarketplacePreviewMode
} from './PluginMarketplacePreviewDialog'
import { PluginMarketplaceSourceDialog } from './PluginMarketplaceSourceDialog'

type PluginMarketplaceBrowserProps = {
  installedPlugins: readonly PluginHostListEntry[]
  onInstalled: (pluginKey: string) => Promise<void>
  onRefreshInstalled?: () => Promise<void>
  renderInstalledContent?: (search: string) => React.ReactNode
}

function marketplaceError(cause: unknown, fallback: string): string {
  console.warn('[plugins] marketplace action failed:', cause)
  return fallback
}

export function PluginMarketplaceBrowser({
  installedPlugins,
  onInstalled,
  onRefreshInstalled,
  renderInstalledContent
}: PluginMarketplaceBrowserProps): React.JSX.Element {
  const api = usePluginCatalogApi()
  const type = useAppStore((state) => state.pluginCatalogTypeFilter)
  const onTypeChange = useAppStore((state) => state.setPluginCatalogTypeFilter)
  const [sources, setSources] = useState<PluginMarketplaceHostSourceState[]>([])
  const [listings, setListings] = useState<PluginMarketplaceHostListing[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshBusy, setRefreshBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<PluginCatalogFilter>('all')
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [preview, setPreview] = useState<PluginMarketplaceHostInstallPreview | null>(null)
  const [previewMode, setPreviewMode] = useState<PluginMarketplacePreviewMode>('install')
  const [previewBusyKey, setPreviewBusyKey] = useState<string | null>(null)
  const [installBusy, setInstallBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const mountedRef = useRef(false)
  const requestRef = useRef(0)
  const previewRequestRef = useRef(0)

  const loadMarketplaceData = useCallback(async (): Promise<void> => {
    const requestId = ++requestRef.current
    try {
      const [nextSources, nextListings] = await Promise.all([
        api.listMarketplaces(),
        api.listMarketplacePlugins()
      ])
      if (mountedRef.current && requestId === requestRef.current) {
        setSources(nextSources)
        setListings(nextListings)
        setError(null)
      }
    } catch (cause) {
      if (mountedRef.current && requestId === requestRef.current) {
        setError(
          marketplaceError(
            cause,
            translate(
              'auto.components.settings.PluginMarketplaceBrowser.loadFailed',
              'Could not load marketplace plugins.'
            )
          )
        )
      }
    } finally {
      if (mountedRef.current && requestId === requestRef.current) {
        setLoading(false)
      }
    }
  }, [api])

  useEffect(() => {
    mountedRef.current = true
    void loadMarketplaceData()
    return () => {
      mountedRef.current = false
      requestRef.current += 1
      previewRequestRef.current += 1
    }
  }, [loadMarketplaceData])

  const installedByKey = useMemo(
    () =>
      new Map(
        installedPlugins
          .filter((plugin) => !plugin.bundledData)
          .map((plugin) => [plugin.pluginKey, plugin])
      ),
    [installedPlugins]
  )

  const refresh = async (): Promise<void> => {
    setRefreshBusy(true)
    setError(null)
    try {
      await Promise.all([api.refreshMarketplaces({}), onRefreshInstalled?.()])
      await loadMarketplaceData()
    } catch (cause) {
      if (mountedRef.current) {
        setError(
          marketplaceError(
            cause,
            translate(
              'auto.components.settings.PluginMarketplaceBrowser.refreshFailed',
              'Could not refresh marketplaces. Cached listings remain available.'
            )
          )
        )
      }
    } finally {
      if (mountedRef.current) {
        setRefreshBusy(false)
      }
    }
  }

  const openPreview = async (
    listing: PluginMarketplaceHostListing,
    update: boolean
  ): Promise<void> => {
    const requestId = ++previewRequestRef.current
    setPreviewBusyKey(listing.pluginKey)
    setActionError(null)
    setError(null)
    try {
      if (listing.release?.execution === 'data' && api.installMarketplaceDataPlugin) {
        const result = await api.installMarketplaceDataPlugin({
          marketplaceSourceId: listing.marketplaceSourceId,
          marketplaceCommit: listing.marketplaceCommit,
          pluginKey: listing.pluginKey
        })
        if (!mountedRef.current || requestId !== previewRequestRef.current) {
          return
        }
        if (result.kind === 'error') {
          throw new Error(result.error)
        }
        if (result.kind === 'installed') {
          await onInstalled(result.pluginKey)
          return
        }
        setPreviewMode(update ? 'update' : 'install')
        setPreview(result.preview)
        return
      }
      const nextPreview = await api.previewMarketplacePlugin({
        marketplaceSourceId: listing.marketplaceSourceId,
        pluginKey: listing.pluginKey
      })
      if (mountedRef.current && requestId === previewRequestRef.current) {
        setPreviewMode(update ? 'update' : 'install')
        setPreview(nextPreview)
      }
    } catch (cause) {
      if (mountedRef.current && requestId === previewRequestRef.current) {
        setError(
          marketplaceError(
            cause,
            translate(
              'auto.components.settings.PluginMarketplaceBrowser.previewFailed',
              'Could not prepare this plugin for review. Refresh the marketplace and try again.'
            )
          )
        )
      }
    } finally {
      if (mountedRef.current && requestId === previewRequestRef.current) {
        setPreviewBusyKey(null)
      }
    }
  }

  const installPreview = async (): Promise<void> => {
    if (!preview || installBusy) {
      return
    }
    setInstallBusy(true)
    setActionError(null)
    try {
      const identity = {
        marketplaceSourceId: preview.marketplaceSourceId,
        marketplaceCommit: preview.marketplaceCommit,
        pluginKey: preview.pluginKey,
        resolvedCommit: preview.resolvedCommit
      }
      const currentContentHash = installedByKey.get(preview.pluginKey)?.source?.contentHash
      const reviewedUpdate = previewMode === 'update' && preview.manifest.manifestVersion === 2
      if (
        reviewedUpdate &&
        (!api.approveMarketplaceUpdate || !currentContentHash || !preview.reviewRevision)
      ) {
        throw new Error(
          translate(
            'auto.components.settings.PluginMarketplaceBrowser.updateUnsupported',
            'This host cannot approve an update safely. Update Orca and try again; your installed plugin is unchanged.'
          )
        )
      }
      const result =
        reviewedUpdate &&
        api.approveMarketplaceUpdate &&
        currentContentHash &&
        preview.reviewRevision
          ? await api.approveMarketplaceUpdate({
              ...identity,
              contentHash: preview.contentHash,
              reviewedFingerprint: preview.consentFingerprint,
              reviewedRevision: preview.reviewRevision,
              ...(preview.environmentRecipeReviewDigest
                ? { reviewedEnvironmentRecipeDigest: preview.environmentRecipeReviewDigest }
                : {}),
              currentContentHash
            })
          : await api.installMarketplacePlugin(identity)
      if (!result.ok) {
        throw new Error(result.error)
      }
      setPreview(null)
      await onInstalled(result.pluginKey)
    } catch (cause) {
      if (mountedRef.current) {
        setActionError(
          marketplaceError(
            cause,
            translate(
              'auto.components.settings.PluginMarketplaceBrowser.installFailed',
              'Could not install this plugin. The reviewed source may have changed.'
            )
          )
        )
      }
    } finally {
      if (mountedRef.current) {
        setInstallBusy(false)
      }
    }
  }

  const currentVersion = Boolean(
    preview &&
    installedByKey.get(preview.pluginKey)?.source?.contentHash === preview.contentHash &&
    installedByKey.get(preview.pluginKey)?.consentFingerprint === preview.consentFingerprint
  )

  return (
    <>
      <PluginCatalogLayout
        filter={filter}
        onFilterChange={setFilter}
        search={search}
        onSearchChange={setSearch}
        allCount={listings.length}
        installedCount={installedPlugins.filter((plugin) => !plugin.bundledData).length}
        toolbar={
          <>
            <Button variant="ghost" size="xs" onClick={() => setSourcesOpen(true)}>
              <Settings2 />
              {translate(
                'auto.components.settings.PluginMarketplaceBrowser.manageSources',
                'Manage sources'
              )}
            </Button>
            <Button variant="ghost" size="xs" disabled={refreshBusy} onClick={() => void refresh()}>
              <RefreshCw className={refreshBusy ? 'animate-spin' : undefined} />
              {refreshBusy
                ? translate(
                    'auto.components.settings.PluginMarketplaceBrowser.refreshing',
                    'Refreshing…'
                  )
                : translate('auto.components.settings.PluginMarketplaceBrowser.refresh', 'Refresh')}
            </Button>
          </>
        }
      >
        {filter === 'installed' ? (
          renderInstalledContent ? (
            renderInstalledContent(search)
          ) : (
            <PluginCatalogEmptyState
              icon={Blocks}
              title={translate(
                'auto.components.settings.PluginMarketplaceBrowser.noInstalledTitle',
                'No plugins installed'
              )}
              description={translate(
                'auto.components.settings.PluginMarketplaceBrowser.noInstalled',
                'Plugins you install appear here.'
              )}
            />
          )
        ) : loading ? (
          <div className="flex items-center gap-2 px-4 py-5 text-[13px] text-muted-foreground">
            <Loader2 className="animate-spin" />
            {translate(
              'auto.components.settings.PluginMarketplaceBrowser.loading',
              'Loading marketplace plugins…'
            )}
          </div>
        ) : (
          <>
            {error ? (
              <div className="mb-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                <p>{error}</p>
                <Button variant="outline" size="xs" className="mt-2" onClick={loadMarketplaceData}>
                  {translate(
                    'auto.components.settings.PluginMarketplaceBrowser.tryAgain',
                    'Try again'
                  )}
                </Button>
              </div>
            ) : null}
            {sources.some((source) => source.stale) ? (
              <p role="status" className="mb-3 text-xs leading-5 text-muted-foreground">
                {translate(
                  'auto.components.settings.PluginCatalogDetail.cached',
                  'Showing cached listings. Some sources could not be refreshed; installed plugins remain available.'
                )}
              </p>
            ) : null}
            {sources.length === 0 ? (
              <PluginCatalogEmptyState
                icon={Store}
                title={translate(
                  'auto.components.settings.PluginMarketplaceBrowser.noSourcesTitle',
                  'No marketplaces configured'
                )}
                description={translate(
                  'auto.components.settings.PluginMarketplaceBrowser.noSources',
                  'Add an official, community, or private Git marketplace to browse plugins.'
                )}
                action={
                  <Button variant="outline" size="sm" onClick={() => setSourcesOpen(true)}>
                    {translate(
                      'auto.components.settings.PluginMarketplaceBrowser.addSource',
                      'Add marketplace'
                    )}
                  </Button>
                }
              />
            ) : listings.length === 0 ? (
              <PluginCatalogEmptyState
                icon={Blocks}
                title={translate(
                  'auto.components.settings.PluginMarketplaceBrowser.emptyTitle',
                  'Nothing listed yet'
                )}
                description={translate(
                  'auto.components.settings.PluginMarketplaceBrowser.empty',
                  'The configured marketplaces do not list any plugins.'
                )}
              />
            ) : (
              <PluginCatalogResults
                listings={listings}
                installedByKey={installedByKey}
                search={search}
                type={type}
                onTypeChange={onTypeChange}
                busyKey={previewBusyKey}
                onClearSearch={() => setSearch('')}
                onPreview={(entry, update) => void openPreview(entry, update)}
              />
            )}
          </>
        )}
      </PluginCatalogLayout>
      <PluginMarketplaceSourceDialog
        open={sourcesOpen}
        sources={sources}
        onOpenChange={setSourcesOpen}
        onChanged={loadMarketplaceData}
      />
      <PluginMarketplacePreviewDialog
        key={preview ? `${preview.pluginKey}:${preview.contentHash}` : 'closed'}
        preview={preview}
        mode={previewMode}
        installedVersion={preview ? installedByKey.get(preview.pluginKey)?.version : undefined}
        busy={installBusy}
        currentVersion={currentVersion}
        error={actionError}
        onClose={() => setPreview(null)}
        onConfirm={() => void installPreview()}
      />
    </>
  )
}
