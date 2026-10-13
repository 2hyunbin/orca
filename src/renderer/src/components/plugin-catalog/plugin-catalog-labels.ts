import { translate } from '@/i18n/i18n'
import type { PluginCatalogTypeFilter } from './plugin-catalog-filter'
import type { PluginExecutionProfile } from '../../../../shared/plugins/plugin-execution-profile'

export function pluginCatalogFilterLabel(filter: PluginCatalogTypeFilter): string {
  switch (filter) {
    case 'all':
      return translate('auto.components.settings.PluginCatalogDetail.allTypes', 'All types')
    case 'interface-language':
      return translate(
        'auto.components.settings.PluginCatalogDetail.interfaceLanguages',
        'Interface languages'
      )
    case 'coding-language':
      return translate(
        'auto.components.settings.PluginCatalogDetail.codingLanguages',
        'Coding languages'
      )
    case 'file-viewer':
      return translate('auto.components.settings.PluginCatalogDetail.fileViewers', 'File viewers')
    case 'environment-provider':
      return translate(
        'auto.components.settings.PluginCatalogDetail.environmentProviders',
        'Environment providers'
      )
    case 'appearance':
      return translate('auto.components.settings.PluginCatalogDetail.appearance', 'Appearance')
    case 'other':
      return translate('auto.components.settings.PluginCatalogDetail.other', 'Other plugins')
  }
}

export function pluginExecutionDescription(profile: PluginExecutionProfile): string {
  switch (profile) {
    case 'data':
      return translate(
        'auto.components.settings.PluginCatalogDetail.dataDescription',
        'Data only. No executable plugin code or host permissions.'
      )
    case 'sandboxed-ui':
      return translate(
        'auto.components.settings.PluginCatalogDetail.uiDescription',
        'Runs plugin UI in an isolated surface. Review its access before enabling.'
      )
    case 'instructional':
      return translate(
        'auto.components.settings.PluginCatalogDetail.instructionsDescription',
        'Adds commands or instructions. Review what they do before enabling.'
      )
    case 'trusted-worker':
      return translate(
        'auto.components.settings.PluginCatalogDetail.workerDescription',
        'Runs a full-trust process on this computer. Review the publisher and requested access.'
      )
  }
}
