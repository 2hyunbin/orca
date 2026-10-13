import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import {
  pluginSyntaxLanguageKey,
  type PluginSyntaxPackMetadata,
  type PluginSyntaxPackPayload
} from '../../shared/plugins/plugin-syntax-pack'
import {
  verifyHashAddressedPluginContent,
  type PluginContentVerifier
} from './plugin-content-integrity'
import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'
import { readPluginSyntaxContent } from './plugin-syntax-content'
import { PluginSyntaxArtifactSnapshot } from './plugin-syntax-artifact-snapshot'

type Descriptor = {
  plugin: ValidDiscoveredPlugin
  metadata: PluginSyntaxPackMetadata
  approved: () => boolean
  artifacts: PluginSyntaxArtifactSnapshot
}

export class PluginSyntaxPackRegistry {
  private descriptors = new Map<string, Descriptor>()
  private readonly errors = new Map<string, string>()
  private generation = 0

  constructor(
    private readonly verifier: PluginContentVerifier,
    private readonly canRead: (plugin: ValidDiscoveredPlugin) => boolean = () => true,
    private readonly builtInLanguage: (
      plugin: ValidDiscoveredPlugin,
      language: string
    ) => 'typst' | undefined = () => undefined
  ) {}

  list(): PluginSyntaxPackMetadata[] {
    return [...this.descriptors.values()]
      .filter((item) => item.approved() && this.canRead(item.plugin))
      .map((item) => item.metadata)
  }

  error(pluginKey: string): string | null {
    return this.errors.get(pluginKey) ?? null
  }

  async reconcile(
    discovered: readonly DiscoveredPlugin[],
    isApproved: (plugin: ValidDiscoveredPlugin) => boolean
  ): Promise<void> {
    const generation = ++this.generation
    this.descriptors.clear()
    this.errors.clear()
    const candidates = discovered.filter(
      (plugin): plugin is ValidDiscoveredPlugin =>
        !isInvalidDiscoveredPlugin(plugin) &&
        isApproved(plugin) &&
        plugin.manifest.manifestVersion === 2 &&
        plugin.manifest.contributes.languages.length > 0
    )
    const results = await mapWithConcurrency(
      candidates,
      2,
      async (plugin): Promise<Descriptor | null> => {
        try {
          await this.verifier.verify(plugin)
          const artifacts = new PluginSyntaxArtifactSnapshot(plugin.rootDir)
          const content = await readPluginSyntaxContent(plugin.manifest, (path, max) =>
            artifacts.capture(path, max)
          )
          const integrity = await verifyHashAddressedPluginContent(plugin)
          if (!integrity.ok) {
            throw new Error(`syntax package changed during metadata admission: ${integrity.error}`)
          }
          return {
            plugin,
            artifacts,
            approved: () => isApproved(plugin),
            metadata: {
              pluginKey: plugin.pluginKey,
              name: plugin.manifest.name,
              revision: plugin.contentHash ?? `dev:${generation}`,
              languages: content.languages.map(
                ({ configuration: _configuration, ...language }) => ({
                  ...language,
                  builtInLanguage: this.builtInLanguage(plugin, language.id),
                  key: pluginSyntaxLanguageKey(plugin.pluginKey, language.id)
                })
              )
            }
          }
        } catch (error) {
          if (generation === this.generation) {
            this.errors.set(
              plugin.pluginKey,
              error instanceof Error ? error.message : String(error)
            )
          }
          return null
        }
      }
    )
    if (generation !== this.generation) {
      return
    }
    this.descriptors = new Map(
      results
        .filter((item): item is Descriptor => item !== null && item.approved())
        .map((item) => [item.plugin.pluginKey, item])
    )
  }

  async load(pluginKey: string, revision: string): Promise<PluginSyntaxPackPayload | null> {
    const descriptor = this.descriptors.get(pluginKey)
    if (
      !descriptor ||
      descriptor.metadata.revision !== revision ||
      !descriptor.approved() ||
      !this.canRead(descriptor.plugin)
    ) {
      return null
    }
    const plugin = descriptor.plugin
    await this.verifier.verify(plugin)
    const content = await readPluginSyntaxContent(plugin.manifest, (path, max) =>
      descriptor.artifacts.read(path, max)
    )
    if (
      this.descriptors.get(pluginKey) !== descriptor ||
      !descriptor.approved() ||
      !this.canRead(plugin)
    ) {
      return null
    }
    return {
      ...descriptor.metadata,
      languages: content.languages.map((language) => ({
        ...language,
        builtInLanguage: this.builtInLanguage(plugin, language.id),
        key: pluginSyntaxLanguageKey(pluginKey, language.id)
      })),
      grammars: content.grammars
    }
  }
}
