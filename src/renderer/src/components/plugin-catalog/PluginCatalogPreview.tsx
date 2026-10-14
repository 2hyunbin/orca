import type { PluginCatalogRelease } from '../../../../shared/plugins/plugin-catalog-release'

export function PluginCatalogPreview({
  preview,
  label,
  compact = false
}: {
  preview: NonNullable<PluginCatalogRelease['preview']>
  label: string
  compact?: boolean
}): React.JSX.Element {
  return (
    <section className="min-w-0 rounded-md border border-border bg-muted/40 p-3" aria-label={label}>
      <h3 className="mb-2 truncate text-xs font-medium text-muted-foreground">{preview.title}</h3>
      <pre
        className={
          compact
            ? 'line-clamp-3 whitespace-pre-wrap break-words font-mono text-xs leading-5'
            : 'whitespace-pre-wrap break-words font-mono text-xs leading-5'
        }
      >
        {compact ? preview.text.slice(0, 500) : preview.text}
      </pre>
    </section>
  )
}
