import type { PluginSyntaxAssociation } from './plugin-syntax-associations'
import type { PluginViewerAssociation } from './plugin-viewer-associations'

export type PluginGlobalSettings = {
  pluginAppTheme?: `plugin:${string}` | null
  pluginIconTheme?: `plugin:${string}` | null
  /** Optional plugin execution; shipped language data is separate. */
  pluginSystemEnabled: boolean
  disabledPlugins: string[]
  disabledBundledDataPlugins?: string[]
  /** Changed trust fingerprints require fresh approval before execution. */
  pluginConsents: Record<string, string>
  devPluginPaths: string[]
  pluginSyntaxAssociations?: PluginSyntaxAssociation[]
  pluginViewerAssociations?: PluginViewerAssociation[]
}
