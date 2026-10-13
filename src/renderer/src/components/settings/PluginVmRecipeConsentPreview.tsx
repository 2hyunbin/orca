import type { PluginHostListEntry } from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { PluginRecipeConsentPreview } from './PluginRecipeConsentPreview'

type VmRecipePreview = NonNullable<PluginHostListEntry['vmRecipes']>[number]

function lifecycleLabel(phase: VmRecipePreview['commands'][number]['phase']): string {
  switch (phase) {
    case 'create':
      return translate('auto.components.settings.PluginVmRecipeConsentPreview.create', 'Create')
    case 'suspend':
      return translate('auto.components.settings.PluginVmRecipeConsentPreview.suspend', 'Suspend')
    case 'resume':
      return translate('auto.components.settings.PluginVmRecipeConsentPreview.resume', 'Resume')
    case 'destroy':
      return translate('auto.components.settings.PluginVmRecipeConsentPreview.destroy', 'Destroy')
  }
}

export function PluginVmRecipeConsentPreview({
  recipes
}: {
  recipes: readonly VmRecipePreview[]
}): React.JSX.Element | null {
  return (
    <PluginRecipeConsentPreview
      headingId="plugin-vm-recipe-consent-heading"
      heading={translate(
        'auto.components.settings.PluginVmRecipeConsentPreview.heading',
        'VM recipe commands'
      )}
      recipes={recipes.map((recipe) => ({
        id: recipe.id,
        name: recipe.name,
        description: recipe.description,
        commands: recipe.commands.map(({ phase, command }) => ({
          id: phase,
          label: lifecycleLabel(phase),
          text: command
        }))
      }))}
    />
  )
}
