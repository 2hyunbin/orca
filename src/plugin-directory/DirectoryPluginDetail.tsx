import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PluginCatalogAvatar } from '@/components/plugin-catalog/PluginCatalogAvatar'
import { PluginCatalogPreview } from '@/components/plugin-catalog/PluginCatalogPreview'
import {
  browsableRepository,
  directoryReviewCopy,
  type DirectoryCatalog,
  type DirectoryPlugin
} from './directory-catalog'
import { DirectoryCopyField } from './DirectoryCopyField'
import { DirectoryPluginType } from './DirectoryPluginCard'

export function DirectoryPluginDetail({
  plugin,
  source,
  onRestoreFocus
}: {
  plugin: DirectoryPlugin
  source: DirectoryCatalog['source']
  onRestoreFocus: () => void
}): React.JSX.Element {
  const repository = browsableRepository(plugin.source.url)
  return (
    <DialogContent
      className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-2xl"
      onCloseAutoFocus={(event) => {
        event.preventDefault()
        onRestoreFocus()
      }}
    >
      <DialogHeader className="shrink-0 pr-5 text-left">
        <div className="flex min-w-0 items-start gap-3">
          <PluginCatalogAvatar name={plugin.name} />
          <div className="min-w-0">
            <DialogTitle className="break-words">{plugin.name}</DialogTitle>
            <p className="mt-1 break-all text-xs text-muted-foreground">
              {plugin.id} · v{plugin.release.version}
            </p>
          </div>
        </div>
      </DialogHeader>
      <div className="min-h-0 space-y-4 overflow-y-auto">
        <DialogDescription className="break-words">
          {plugin.description ?? plugin.name}
        </DialogDescription>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <DirectoryPluginType plugin={plugin} />
          <span className="text-xs text-muted-foreground">
            Orca {plugin.release.minimumOrca}+ · {plugin.release.license}
          </span>
          {repository && (
            <Button variant="link" size="sm" asChild className="h-auto px-0">
              <a href={repository} target="_blank" rel="noopener noreferrer">
                Source <ExternalLink aria-hidden="true" />
              </a>
            </Button>
          )}
        </div>
        {plugin.release.preview && (
          <PluginCatalogPreview preview={plugin.release.preview} label="Publisher preview" />
        )}
        <section
          className="space-y-2 rounded-md border border-border p-4"
          aria-label="Execution and review"
        >
          <h3 className="text-sm font-medium">
            {plugin.release.execution === 'data' ? 'Data pack' : 'Review before enabling'}
          </h3>
          <p className="text-sm leading-5 text-muted-foreground">
            {plugin.release.types.includes('environment-provider')
              ? 'Manages development machines and sandboxes. Commands run with your account on the selected host. Review the source, account and commands in Orca before enabling.'
              : directoryReviewCopy(plugin.release.execution)}
          </p>
          <p className="text-xs leading-5 text-muted-foreground">
            These are catalog declarations. Orca verifies the actual package and its source before
            activation.
          </p>
        </section>
        <section className="space-y-4" aria-label="Install in Orca">
          <h3 className="text-sm font-semibold">Install in Orca</h3>
          <ol className="list-decimal space-y-2 pl-5 text-sm leading-5 text-muted-foreground">
            <li>
              Open Settings → Plugins. Turn on Plugin system if needed, then Browse → Manage
              sources. Add this Git catalog and ref if they are not already listed.
            </li>
            <li>
              Search for{' '}
              <strong className="break-words font-medium text-foreground">{plugin.name}</strong>,
              then install the matching publisher and package.
            </li>
            <li>
              {plugin.release.execution === 'data'
                ? 'For an interface language, choose Use language. Syntax and appearance packs become available in Orca.'
                : 'Review the executable features and requested access, then enable only if you approve.'}
            </li>
          </ol>
          <DirectoryCopyField
            key={source.url}
            id="catalog-url"
            label="Catalog Git URL"
            value={source.url}
          />
          <DirectoryCopyField
            key={source.ref}
            id="catalog-ref"
            label="Catalog ref"
            value={source.ref}
          />
          <p className="text-xs leading-5 text-muted-foreground">
            Orca refreshes the catalog and checks the release commit and package hash. A cached page
            may show an older release.
          </p>
        </section>
        <details className="min-w-0 rounded-md border border-border p-4">
          <summary className="cursor-pointer text-sm font-medium">Release details</summary>
          <dl className="mt-3 space-y-3 text-xs">
            {[
              ['Package', plugin.id],
              ['Execution', plugin.release.execution],
              ['Repository', plugin.source.url],
              ['Release ref', plugin.source.ref],
              ['Commit', plugin.release.commit],
              ['SHA-256', plugin.release.contentHash],
              ['Contributions', plugin.release.types.join(', ')]
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="mt-1 break-all font-mono">{value}</dd>
              </div>
            ))}
          </dl>
        </details>
      </div>
    </DialogContent>
  )
}
