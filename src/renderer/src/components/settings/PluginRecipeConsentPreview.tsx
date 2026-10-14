import { translate } from '@/i18n/i18n'

export type PluginRecipeConsentContent = {
  id: string
  name: string
  description?: string
  commands: { id: string; label: string; text: string }[]
}

export function PluginRecipeConsentPreview({
  headingId,
  heading,
  notice,
  recipes
}: {
  headingId: string
  heading: string
  notice?: string
  recipes: readonly PluginRecipeConsentContent[]
}): React.JSX.Element | null {
  if (!recipes.length) {
    return null
  }
  return (
    <section className="space-y-3" aria-labelledby={headingId}>
      <h3
        id={headingId}
        className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
      >
        {heading}
      </h3>
      {notice ? <p className="text-xs leading-5 text-muted-foreground">{notice}</p> : null}
      {recipes.map((recipe) => (
        <div key={recipe.id} className="space-y-2 rounded-md border border-border p-3">
          <div>
            <p className="text-sm font-medium">{recipe.name}</p>
            {recipe.description ? (
              <p className="text-xs leading-5 text-muted-foreground">{recipe.description}</p>
            ) : null}
          </div>
          <dl className="space-y-2">
            {recipe.commands.map((command) => (
              <div key={command.id}>
                <dt className="mb-1 text-xs text-muted-foreground">{command.label}</dt>
                <dd>
                  <pre
                    tabIndex={0}
                    aria-label={translate(
                      'auto.components.settings.PluginVmRecipeConsentPreview.commandLabel',
                      '{{value0}} · {{value1}} command',
                      { value0: recipe.name, value1: command.label }
                    )}
                    className="max-h-40 overflow-auto scrollbar-sleek whitespace-pre-wrap break-all rounded-md bg-muted px-2.5 py-2 font-mono text-xs leading-5 text-foreground"
                  >
                    {command.text}
                  </pre>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </section>
  )
}
