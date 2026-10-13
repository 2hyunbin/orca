import type { PluginMarketplaceHostInstallPreview } from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'

export function pluginMarketplaceContributionSummary(
  preview: PluginMarketplaceHostInstallPreview
): { key: string; label: string }[] {
  const { contributes } = preview.manifest
  // Why: two static keys per kind (not one dynamic key) so the localization
  // catalog sync can extract them, and "1 icon themes" never renders.
  const entries: { key: string; count: number; one: string; many: string }[] = [
    {
      key: 'themes',
      count: contributes.themes.length,
      one: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.themesOne',
        '1 app theme'
      ),
      many: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.themes',
        '{{value0}} app themes',
        { value0: contributes.themes.length }
      )
    },
    {
      key: 'iconThemes',
      count: contributes.iconThemes.length,
      one: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.iconThemesOne',
        '1 icon theme'
      ),
      many: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.iconThemes',
        '{{value0}} icon themes',
        { value0: contributes.iconThemes.length }
      )
    },
    {
      key: 'terminalThemes',
      count: contributes.terminalThemes.length,
      one: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.terminalThemesOne',
        '1 terminal theme'
      ),
      many: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.terminalThemes',
        '{{value0}} terminal themes',
        { value0: contributes.terminalThemes.length }
      )
    },
    {
      key: 'languagePacks',
      count: contributes.languagePacks.length,
      one: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.languagePacksOne',
        '1 language pack'
      ),
      many: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.languagePacks',
        '{{value0}} language packs',
        { value0: contributes.languagePacks.length }
      )
    },
    {
      key: 'commands',
      count: contributes.commands.length,
      one: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.commandsOne',
        '1 command'
      ),
      many: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.commands',
        '{{value0}} commands',
        { value0: contributes.commands.length }
      )
    },
    {
      key: 'keybindings',
      count: contributes.keybindings.length,
      one: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.keybindingsOne',
        '1 keyboard shortcut'
      ),
      many: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.keybindings',
        '{{value0}} keyboard shortcuts',
        { value0: contributes.keybindings.length }
      )
    },
    {
      key: 'vmRecipes',
      count: contributes.vmRecipes.length,
      one: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.vmRecipesOne',
        '1 VM recipe'
      ),
      many: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.vmRecipes',
        '{{value0}} VM recipes',
        { value0: contributes.vmRecipes.length }
      )
    },
    {
      key: 'panels',
      count: contributes.panels.length,
      one: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.panelsOne',
        '1 panel'
      ),
      many: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.panels',
        '{{value0}} panels',
        { value0: contributes.panels.length }
      )
    },
    {
      key: 'events',
      count: contributes.events.length,
      one: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.eventsOne',
        '1 event subscription'
      ),
      many: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.events',
        '{{value0}} event subscriptions',
        { value0: contributes.events.length }
      )
    }
  ]
  const summary: { key: string; label: string }[] = entries
    .filter((entry) => entry.count > 0)
    .map(({ key, count, one, many }) => ({ key, label: count === 1 ? one : many }))
  if (preview.manifest.manifestVersion === 2 && preview.manifest.contributes.fileViewers.length) {
    const count = preview.manifest.contributes.fileViewers.length
    summary.push({
      key: 'fileViewers',
      label:
        count === 1
          ? translate(
              'auto.components.settings.PluginMarketplacePreviewDialog.viewerOne',
              '1 read-only file viewer'
            )
          : translate(
              'auto.components.settings.PluginMarketplacePreviewDialog.viewers',
              '{{count}} read-only file viewers',
              { count }
            )
    })
  }
  if (
    preview.manifest.manifestVersion === 2 &&
    (preview.manifest.contributes.environmentRecipes?.length ?? 0)
  ) {
    const count = preview.manifest.contributes.environmentRecipes?.length ?? 0
    summary.push({
      key: 'environmentRecipes',
      label:
        count === 1
          ? translate(
              'auto.components.settings.PluginMarketplacePreviewDialog.environmentOne',
              '1 environment provider'
            )
          : translate(
              'auto.components.settings.PluginMarketplacePreviewDialog.environments',
              '{{count}} environment providers',
              { count }
            )
    })
  }
  if (preview.manifest.main) {
    summary.push({
      key: 'worker',
      label: translate(
        'auto.components.settings.PluginMarketplacePreviewDialog.worker',
        'Background worker'
      )
    })
  }
  return summary
}
