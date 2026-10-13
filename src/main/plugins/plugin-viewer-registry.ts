import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import {
  PLUGIN_VIEWER_ENTRY_BYTES,
  type PluginViewerContribution
} from '../../shared/plugins/plugin-viewer-contributions'
import {
  pluginViewerKey,
  pluginViewerMetadataSchema,
  type PluginViewerMetadata
} from '../../shared/plugins/plugin-viewer-package'
import {
  readContainedPluginArtifactText,
  resolveContainedPluginArtifact
} from './plugin-artifact-validation'
import type { PluginContentVerifier } from './plugin-content-integrity'
import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'
import { verifyReviewedPluginRelease } from './plugin-reviewed-release'

type ViewerDescriptor = {
  plugin: ValidDiscoveredPlugin
  contribution: PluginViewerContribution
  metadata: PluginViewerMetadata
  approved(): boolean
}

export class PluginViewerRegistry {
  private readonly errors = new Map<string, string>()
  private descriptors = new Map<string, ViewerDescriptor>()
  private generation = 0

  constructor(
    private readonly verifier: PluginContentVerifier,
    private readonly canRead: (plugin: ValidDiscoveredPlugin) => boolean
  ) {}

  list(): PluginViewerMetadata[] {
    return [...this.descriptors.values()]
      .filter((item) => item.approved() && this.canRead(item.plugin))
      .map((item) => structuredClone(item.metadata))
  }

  error(pluginKey: string): string | null {
    return this.errors.get(pluginKey) ?? null
  }

  async reconcile(
    discovered: readonly DiscoveredPlugin[],
    isApproved: (plugin: ValidDiscoveredPlugin) => boolean
  ): Promise<void> {
    const generation = ++this.generation
    const previous = this.descriptors
    this.errors.clear()
    const candidates = discovered.filter(
      (plugin): plugin is ValidDiscoveredPlugin =>
        !isInvalidDiscoveredPlugin(plugin) &&
        plugin.manifest.manifestVersion === 2 &&
        plugin.manifest.contributes.fileViewers.length > 0 &&
        isApproved(plugin)
    )
    const groups = await mapWithConcurrency(candidates, 2, async (plugin) => {
      try {
        await this.verifier.verify(plugin)
        if (plugin.manifest.manifestVersion !== 2) {return []}
        const descriptors: ViewerDescriptor[] = []
        for (const contribution of plugin.manifest.contributes.fileViewers) {
          await resolveContainedPluginArtifact(
            plugin.rootDir,
            contribution.entry,
            PLUGIN_VIEWER_ENTRY_BYTES
          )
          const { entry: _entry, ...declaration } = contribution
          const key = pluginViewerKey(plugin.pluginKey, contribution.id)
          const revision = plugin.contentHash ?? plugin.reviewRevision ?? `dev:${generation}`
          const old = previous.get(key)
          const unchanged =
            old &&
            old.plugin.rootDir === plugin.rootDir &&
            old.plugin.consentFingerprint === plugin.consentFingerprint &&
            old.metadata.revision === revision
          const metadata = pluginViewerMetadataSchema.parse({
            ...declaration,
            key,
            pluginKey: plugin.pluginKey,
            pluginName: plugin.manifest.name,
            revision,
            generation: unchanged ? old.metadata.generation : generation
          })
          descriptors.push({ plugin, contribution, metadata, approved: () => isApproved(plugin) })
        }
        return descriptors
      } catch (error) {
        if (generation === this.generation) {
          this.errors.set(plugin.pluginKey, error instanceof Error ? error.message : String(error))
        }
        return []
      }
    })
    if (generation !== this.generation) {return}
    this.descriptors = new Map(
      groups
        .flat()
        .filter((item) => item.approved())
        .map((item) => [item.metadata.key, item])
    )
  }

  isCurrent(viewerKey: string, revision: string, generation: number): boolean {
    const descriptor = this.descriptors.get(viewerKey)
    return Boolean(
      descriptor &&
      descriptor.metadata.revision === revision &&
      descriptor.metadata.generation === generation &&
      descriptor.approved() &&
      this.canRead(descriptor.plugin)
    )
  }

  async loadSource(
    viewerKey: string,
    revision: string,
    generation: number
  ): Promise<string | null> {
    const descriptor = this.descriptors.get(viewerKey)
    if (!descriptor || !this.isCurrent(viewerKey, revision, generation)) {return null}
    await verifyReviewedPluginRelease(descriptor.plugin, descriptor.plugin.reviewRevision)
    const source = await readContainedPluginArtifactText(
      descriptor.plugin.rootDir,
      descriptor.contribution.entry,
      PLUGIN_VIEWER_ENTRY_BYTES
    )
    await verifyReviewedPluginRelease(descriptor.plugin, descriptor.plugin.reviewRevision)
    if (
      this.descriptors.get(viewerKey) !== descriptor ||
      !this.isCurrent(viewerKey, revision, generation)
    ) {
      return null
    }
    return source
  }
}
