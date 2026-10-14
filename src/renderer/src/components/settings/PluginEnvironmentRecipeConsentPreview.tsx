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

function reviewedCommandText(command: PluginEnvironmentRecipePreview['commands'][number]): string {
  const program = command.entry
    ? `${translate('auto.components.settings.PluginEnvironmentRecipeConsentPreview.nodeRuntime', 'Orca-provided Node runtime')}\n${translate('auto.components.settings.PluginEnvironmentRecipeConsentPreview.adapterEntry', 'Reviewed adapter')}: ${command.entry}`
    : command.program
  return `${program}\n${translate('auto.components.settings.PluginEnvironmentRecipeConsentPreview.literalArguments', 'Literal arguments')}: ${JSON.stringify(command.args)}\n${translate('auto.components.settings.PluginEnvironmentRecipeConsentPreview.timeout', 'Timeout')}: ${command.timeoutSeconds}s`
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
      notice={
        recipes.some((recipe) => recipe.commands.some((command) => command.entry))
          ? translate(
              'auto.components.settings.PluginEnvironmentRecipeConsentPreview.adapterAuthority',
              'Runs code with this control host’s account permissions, credentials and network access.'
            )
          : undefined
      }
      recipes={recipes.map((recipe) => ({
        id: recipe.providerId,
        name: recipe.name,
        description: recipe.description,
        commands: recipe.commands.map((command) => ({
          id: command.action,
          label: actionLabel(command.action),
          text: reviewedCommandText(command)
        }))
      }))}
    />
  )
}
