import { useEffect, useRef, useState } from 'react'
import { Loader2, Moon, Puzzle, RefreshCw, Search, Sun, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  filterPluginCatalog,
  PLUGIN_CATALOG_FILTERS,
  type PluginCatalogTypeFilter
} from '@/components/plugin-catalog/plugin-catalog-filter'
import {
  DIRECTORY_TYPE_LABELS,
  directoryListings,
  browsableRepository,
  type DirectoryPlugin
} from './directory-catalog'
import { applyDirectoryTheme, saveDirectoryTheme, type DirectoryTheme } from './directory-theme'
import { DirectoryPluginCard } from './DirectoryPluginCard'
import { DirectoryPluginDetail } from './DirectoryPluginDetail'
import { useDirectoryCatalog } from './use-directory-catalog'

const PAGE_SIZE = 24

export function PluginDirectory({
  initialTheme
}: {
  initialTheme: DirectoryTheme
}): React.JSX.Element {
  const state = useDirectoryCatalog()
  const [theme, setTheme] = useState(initialTheme)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<PluginCatalogTypeFilter>('all')
  const [shown, setShown] = useState(PAGE_SIZE)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selectedButton = useRef<HTMLButtonElement | null>(null)
  const searchInput = useRef<HTMLInputElement | null>(null)
  const listings = state.catalog ? directoryListings(state.catalog.catalog) : []
  const matches = filterPluginCatalog(listings, search, category)
  const selected = listings.find((plugin) => plugin.id === selectedId)
  const contributionSource = state.catalog ? browsableRepository(state.catalog.source.url) : null
  const changeSearch = (value: string): void => {
    setSearch(value)
    setShown(PAGE_SIZE)
  }
  const changeCategory = (value: string): void => {
    const filter = PLUGIN_CATALOG_FILTERS.find((candidate) => candidate === value)
    if (!filter) {
      return
    }
    setCategory(filter)
    setShown(PAGE_SIZE)
  }
  const select = (plugin: DirectoryPlugin, button: HTMLButtonElement): void => {
    selectedButton.current = button
    setSelectedId(plugin.id)
  }
  useEffect(() => {
    applyDirectoryTheme(theme)
  }, [theme])
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <a
        href="#plugins"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-card focus:p-3"
      >
        Skip to plugins
      </a>
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
          <a
            href="./"
            className="flex items-center gap-2 text-sm font-semibold"
            aria-label="Orca plugin directory"
          >
            <Puzzle className="size-5" aria-hidden="true" />
            Orca <span className="font-normal text-muted-foreground">/ Plugins</span>
          </a>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`}
            onClick={() => {
              const next = theme === 'dark' ? 'light' : 'dark'
              setTheme(next)
              saveDirectoryTheme(next)
            }}
          >
            {theme === 'dark' ? <Sun /> : <Moon />}
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-5 pb-16 pt-12 sm:px-8 sm:pt-16">
        <div className="max-w-2xl space-y-4">
          <p className="text-xs font-medium text-muted-foreground">MAKE ORCA YOURS</p>
          <h1 className="text-3xl font-semibold sm:text-4xl">
            Small additions.
            <br />
            More possibilities.
          </h1>
          <p className="text-base leading-6 text-muted-foreground">
            Speak your language, highlight your code, open more file formats, and connect to your
            company’s development environments.
          </p>
        </div>
        <section id="plugins" aria-label="Plugin directory" className="mt-10 scroll-mt-4">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <div className="relative w-full sm:max-w-md">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                ref={searchInput}
                aria-label="Search plugins"
                placeholder="Search plugins, publishers, or formats…"
                value={search}
                onChange={(event) => changeSearch(event.target.value)}
                className="pl-9 pr-10"
              />
              {search && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Clear search"
                  className="absolute right-1 top-1/2 -translate-y-1/2"
                  onClick={() => {
                    changeSearch('')
                    searchInput.current?.focus()
                  }}
                >
                  <X />
                </Button>
              )}
            </div>
            <p role="status" className="text-xs text-muted-foreground">
              {state.loading && !state.catalog
                ? 'Loading plugins…'
                : `${matches.length} ${matches.length === 1 ? 'plugin' : 'plugins'}${search ? ' found' : ''}`}
            </p>
          </div>
          <Tabs value={category} onValueChange={changeCategory} className="mt-5 min-w-0">
            <TabsList
              aria-label="Plugin categories"
              className="w-full flex-wrap justify-start gap-1 bg-transparent p-0 group-data-[orientation=horizontal]/tabs:h-auto"
            >
              {PLUGIN_CATALOG_FILTERS.map((filter) => (
                <TabsTrigger
                  key={filter}
                  value={filter}
                  className="h-9 flex-none rounded-md px-3 data-[state=active]:bg-muted data-[state=active]:shadow-none"
                >
                  {DIRECTORY_TYPE_LABELS[filter]}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value={category} className="min-w-0">
              {(state.cached || state.error) && state.catalog && (
                <div
                  className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/40 p-4"
                  role="status"
                >
                  <p className="text-sm text-muted-foreground">
                    {state.error
                      ? 'Could not refresh. Showing the last loaded catalog; release details may be out of date.'
                      : 'Showing a cached catalog while checking for updates.'}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={state.loading}
                    onClick={state.retry}
                  >
                    <RefreshCw />
                    {state.loading ? 'Refreshing…' : 'Retry'}
                  </Button>
                </div>
              )}
              {state.loading && !state.catalog && (
                <div className="flex items-center gap-3 py-16 text-sm text-muted-foreground">
                  <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                  Loading the catalog…
                </div>
              )}
              {state.error && !state.catalog && (
                <div
                  className="my-6 rounded-lg border border-border bg-card p-8 text-center"
                  role="alert"
                >
                  <h2 className="text-sm font-semibold">Catalog unavailable</h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Check your connection and try again. Only a valid pinned catalog can be
                    displayed.
                  </p>
                  <Button
                    variant="outline"
                    className="mt-5"
                    disabled={state.loading}
                    onClick={state.retry}
                  >
                    <RefreshCw />
                    Try again
                  </Button>
                </div>
              )}
              {state.catalog && (
                <Dialog
                  open={Boolean(selected)}
                  onOpenChange={(open) => {
                    if (!open) {
                      setSelectedId(null)
                    }
                  }}
                >
                  {matches.length ? (
                    <div className="mt-6 grid items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {matches.slice(0, shown).map((plugin) => (
                        <DirectoryPluginCard key={plugin.id} plugin={plugin} onSelect={select} />
                      ))}
                    </div>
                  ) : (
                    <div className="my-6 rounded-lg border border-dashed border-border p-10 text-center">
                      <h2 className="text-sm font-semibold">
                        {listings.length ? 'No plugins match' : 'No plugins listed'}
                      </h2>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {listings.length
                          ? 'Try another search or browse all categories.'
                          : 'This catalog has no published listings yet. Check back later or contribute a plugin.'}
                      </p>
                      {listings.length > 0 && (
                        <Button
                          variant="outline"
                          className="mt-5"
                          onClick={() => {
                            changeSearch('')
                            changeCategory('all')
                            searchInput.current?.focus()
                          }}
                        >
                          Clear filters
                        </Button>
                      )}
                    </div>
                  )}
                  {selected && (
                    <DirectoryPluginDetail
                      key={selected.id}
                      plugin={selected}
                      source={state.catalog.source}
                      onRestoreFocus={() => {
                        const button = selectedButton.current
                        if (button?.isConnected) {
                          button.focus()
                        } else {
                          searchInput.current?.focus()
                        }
                      }}
                    />
                  )}
                </Dialog>
              )}
              {matches.length > shown && (
                <div className="mt-8 text-center">
                  <Button variant="outline" onClick={() => setShown((count) => count + PAGE_SIZE)}>
                    Show more plugins ({matches.length - shown} remaining)
                  </Button>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </section>
        <footer className="mt-12 flex flex-col justify-between gap-3 border-t border-border pt-6 text-xs leading-5 text-muted-foreground sm:flex-row">
          <p>
            {state.catalog
              ? `Catalog: ${state.catalog.catalog.name} · ${state.catalog.catalog.owner}`
              : 'Orca plugin directory'}
            <br />
            Install and manage plugins in Orca → Settings → Plugins.
          </p>
          <p className="max-w-sm">
            Package permissions are reviewed in Orca. Data packs cannot gain executable features
            through an unapproved update.
            {contributionSource && (
              <a
                href={contributionSource}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 block text-foreground underline underline-offset-4"
              >
                Contribute a plugin to this catalog
              </a>
            )}
          </p>
        </footer>
      </main>
    </div>
  )
}
