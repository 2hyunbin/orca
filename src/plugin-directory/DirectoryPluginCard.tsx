import { BookOpen, Code2, File, Palette, Puzzle, Server } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { PluginCatalogAvatar } from '@/components/plugin-catalog/PluginCatalogAvatar'
import { PluginCatalogPreview } from '@/components/plugin-catalog/PluginCatalogPreview'
import type { DirectoryPlugin } from './directory-catalog'

export function DirectoryPluginType({ plugin }: { plugin: DirectoryPlugin }): React.JSX.Element {
  const types = plugin.release.types
  const [Icon, label] = types.includes('interface-language')
    ? ([BookOpen, 'Interface language'] as const)
    : types.includes('coding-language')
      ? ([Code2, 'Coding language'] as const)
      : types.includes('file-viewer')
        ? ([File, 'File viewer'] as const)
        : types.includes('environment-provider')
          ? ([Server, 'Environment provider'] as const)
          : types.some((type) => ['app-theme', 'icon-theme', 'terminal-theme'].includes(type))
            ? ([Palette, 'Appearance'] as const)
            : ([Puzzle, 'Other'] as const)
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <Icon aria-hidden="true" className="size-3.5" />
      {label}
    </span>
  )
}

export function DirectoryPluginCard({
  plugin,
  onSelect
}: {
  plugin: DirectoryPlugin
  onSelect: (plugin: DirectoryPlugin, button: HTMLButtonElement) => void
}): React.JSX.Element {
  const preview = plugin.release.preview
  return (
    <Card className="min-w-0 gap-0 border-border py-0 shadow-xs">
      <button
        type="button"
        onClick={(event) => onSelect(plugin, event.currentTarget)}
        aria-label={`View ${plugin.name}`}
        aria-haspopup="dialog"
        className="group flex min-w-0 flex-1 flex-col rounded-xl p-5 text-left transition-colors hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
      >
        <div className="flex min-w-0 items-start gap-3">
          <PluginCatalogAvatar name={plugin.name} />
          <div className="min-w-0 flex-1">
            <h2 className="line-clamp-2 break-words text-sm font-semibold">{plugin.name}</h2>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {plugin.id.split('.')[0]} · v{plugin.release.version}
            </p>
          </div>
        </div>
        <p className="mt-4 line-clamp-2 min-h-10 break-words text-sm leading-5 text-muted-foreground">
          {plugin.description ?? plugin.name}
        </p>
        {preview && (
          <div className="mt-4 w-full min-w-0">
            <PluginCatalogPreview preview={preview} label="Publisher preview" compact />
          </div>
        )}
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-5">
          <DirectoryPluginType plugin={plugin} />
          <Badge variant="secondary" className="text-xs">
            {plugin.release.execution === 'data' ? 'Declared data pack' : 'Review required'}
          </Badge>
        </div>
      </button>
    </Card>
  )
}
