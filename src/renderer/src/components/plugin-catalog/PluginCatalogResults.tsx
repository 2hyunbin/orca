import { useRef, useState } from 'react'
import { LayoutGrid, PanelLeft, SearchX } from 'lucide-react'
import type {
  PluginHostListEntry,
  PluginMarketplaceHostListing
} from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '../ui/sheet'
import { PluginMarketplaceListingRow } from '../settings/PluginMarketplaceListingRow'
import { PluginCatalogEmptyState } from './PluginCatalogEmptyState'
import { PluginCatalogDetail } from './PluginCatalogDetail'
import {
  PLUGIN_CATALOG_FILTERS,
  filterPluginCatalog,
  pluginCatalogListingIdentity,
  type PluginCatalogTypeFilter
} from './plugin-catalog-filter'
import { pluginCatalogFilterLabel } from './plugin-catalog-labels'
import { pluginDisplayNameFromKey } from './plugin-display-name'
import { cn } from '@/lib/utils'

type Props = {
  listings: readonly PluginMarketplaceHostListing[]
  installedByKey: ReadonlyMap<string, PluginHostListEntry>
  search: string
  type: PluginCatalogTypeFilter
  onTypeChange: (type: PluginCatalogTypeFilter) => void
  busyKey: string | null
  onClearSearch: () => void
  onPreview: (listing: PluginMarketplaceHostListing, update: boolean) => void
}

export function PluginCatalogResults({
  listings,
  installedByKey,
  search,
  type,
  onTypeChange,
  busyKey,
  onClearSearch,
  onPreview
}: Props): React.JSX.Element {
  const detailTrigger = useRef<HTMLButtonElement | null>(null)
  const [view, setView] = useState<'cards' | 'split'>('cards')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const visible = filterPluginCatalog(listings, search, type)
  const selected =
    visible.find((listing) => pluginCatalogListingIdentity(listing) === selectedId) ??
    (view === 'split' ? visible[0] : undefined)
  const detail = selected ? (
    <PluginCatalogDetail
      key={pluginCatalogListingIdentity(selected)}
      listing={selected}
      installed={installedByKey.get(selected.pluginKey) ?? null}
      busy={busyKey === selected.pluginKey}
      onPreview={onPreview}
    />
  ) : null
  return (
    <div className="space-y-4">
      <Tabs
        value={view}
        onValueChange={(value) => {
          if (value === 'cards' || value === 'split') {
            setView(value)
            setSelectedId(null)
          }
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Select
              value={type}
              onValueChange={(value) => {
                if (PLUGIN_CATALOG_FILTERS.some((filter) => filter === value)) {
                  onTypeChange(PLUGIN_CATALOG_FILTERS.find((filter) => filter === value) ?? 'all')
                }
                setSelectedId(null)
              }}
            >
              <SelectTrigger
                className="w-48"
                aria-label={translate(
                  'auto.components.settings.PluginCatalogDetail.filterType',
                  'Plugin type'
                )}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLUGIN_CATALOG_FILTERS.map((filter) => (
                  <SelectItem key={filter} value={filter}>
                    {pluginCatalogFilterLabel(filter)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs tabular-nums text-muted-foreground" role="status">
              {visible.length === 1
                ? translate(
                    'auto.components.settings.PluginCatalogDetail.resultCountOne',
                    '1 plugin'
                  )
                : translate(
                    'auto.components.settings.PluginCatalogDetail.resultCount',
                    '{{count}} plugins',
                    { count: visible.length }
                  )}
            </span>
          </div>
          <TabsList
            aria-label={translate(
              'auto.components.settings.PluginCatalogDetail.view',
              'Catalog view'
            )}
          >
            <TabsTrigger value="cards">
              <LayoutGrid className="size-3.5" />
              {translate('auto.components.settings.PluginCatalogDetail.cards', 'Cards')}
            </TabsTrigger>
            <TabsTrigger value="split">
              <PanelLeft className="size-3.5" />
              {translate('auto.components.settings.PluginCatalogDetail.split', 'Split')}
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value={view}>
          {!visible.length ? (
            <PluginCatalogEmptyState
              icon={SearchX}
              title={translate(
                'auto.components.settings.PluginCatalogDetail.noMatches',
                'No matching plugins'
              )}
              description={translate(
                'auto.components.settings.PluginCatalogDetail.adjustFilters',
                'Try another type or search to find a plugin.'
              )}
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onTypeChange('all')
                    onClearSearch()
                  }}
                >
                  {translate(
                    'auto.components.settings.PluginCatalogDetail.clearFilters',
                    'Clear filters'
                  )}
                </Button>
              }
            />
          ) : view === 'cards' ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {visible.map((listing) => (
                <PluginMarketplaceListingRow
                  key={pluginCatalogListingIdentity(listing)}
                  listing={listing}
                  installed={installedByKey.get(listing.pluginKey) ?? null}
                  busy={busyKey === listing.pluginKey}
                  onPreview={onPreview}
                  onDetails={(button) => {
                    detailTrigger.current = button
                    setSelectedId(pluginCatalogListingIdentity(listing))
                  }}
                />
              ))}
            </div>
          ) : (
            <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <nav
                aria-label={translate(
                  'auto.components.settings.PluginCatalogDetail.pluginList',
                  'Plugin list'
                )}
                className="max-h-96 space-y-1 overflow-y-auto scrollbar-sleek"
              >
                {visible.map((listing) => (
                  <button
                    key={pluginCatalogListingIdentity(listing)}
                    type="button"
                    className={cn(
                      'w-full rounded-md p-3 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                      selected === listing && 'bg-accent'
                    )}
                    aria-current={selected === listing ? 'true' : undefined}
                    onClick={() => setSelectedId(pluginCatalogListingIdentity(listing))}
                  >
                    <span className="block truncate text-sm font-medium">
                      {listing.name ?? pluginDisplayNameFromKey(listing.pluginKey)}
                    </span>
                    <span className="mt-1 block truncate text-xs text-muted-foreground">
                      {listing.pluginKey}
                    </span>
                    <span className="mt-1 block line-clamp-2 text-xs leading-5 text-muted-foreground">
                      {listing.description}
                    </span>
                  </button>
                ))}
              </nav>
              <aside
                className="min-w-0 rounded-xl border bg-card p-4 text-card-foreground"
                aria-label={translate(
                  'auto.components.settings.PluginCatalogDetail.details',
                  'Plugin details'
                )}
              >
                {detail}
              </aside>
            </div>
          )}
        </TabsContent>
        <Sheet
          open={view === 'cards' && Boolean(selected)}
          onOpenChange={(open) => {
            if (!open) {
              setSelectedId(null)
            }
          }}
        >
          <SheetContent
            onCloseAutoFocus={(event) => {
              if (detailTrigger.current?.isConnected) {
                event.preventDefault()
                detailTrigger.current.focus()
              }
            }}
          >
            <SheetHeader>
              <SheetTitle>
                {translate(
                  'auto.components.settings.PluginCatalogDetail.details',
                  'Plugin details'
                )}
              </SheetTitle>
              <SheetDescription>
                {translate(
                  'auto.components.settings.PluginCatalogDetail.detailsDescription',
                  'Explore the package, source and access before installing.'
                )}
              </SheetDescription>
            </SheetHeader>
            <div className="overflow-y-auto p-5 scrollbar-sleek">{detail}</div>
          </SheetContent>
        </Sheet>
      </Tabs>
    </div>
  )
}
