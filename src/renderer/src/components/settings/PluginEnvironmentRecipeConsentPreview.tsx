import { translate } from '@/i18n/i18n'
import { PluginRecipeConsentPreview } from './PluginRecipeConsentPreview'
import type { PluginEnvironmentRecipePreview } from '../../../../shared/plugins/plugin-environment-recipe-preview'

function actionLabel(action: PluginEnvironmentRecipePreview['commands'][number]['action']): string {
  const labels = {
    create: 'Create',
    list: 'List',
    delete: 'Delete',
    sleep: 'Sleep',
    resume: 'Resume / wake',
    archive: 'Archive',
    'inspect-operation': 'Inspect interrupted operation'
  }
  return translate(
    `auto.components.settings.PluginEnvironmentRecipeConsentPreview.${action}`,
    labels[action]
  )
}

export function PluginEnvironmentRecipeConsentPreview({
  recipes
}: {
  recipes: readonly PluginEnvironmentRecipePreview[]
}): React.JSX.Element | null {
  return (
    <PluginRecipeConsentPreview
      headingId="plugin-environment-recipe-consent-heading"
      heading={translate(
        'auto.components.settings.PluginEnvironmentRecipeConsentPreview.heading',
        'Environment provider commands'
      )}
      recipes={recipes.map((recipe) => ({
        id: recipe.providerId,
        name: recipe.name,
        description: recipe.description,
        commands: recipe.commands.map((command) => ({
          id: command.action,
          label: actionLabel(command.action),
          text: `${command.program}\n${translate('auto.components.settings.PluginEnvironmentRecipeConsentPreview.literalArguments', 'Literal arguments')}: ${JSON.stringify(command.args)}\n${translate('auto.components.settings.PluginEnvironmentRecipeConsentPreview.timeout', 'Timeout')}: ${command.timeoutSeconds}s`
        }))
      }))}
    />
  )
}
