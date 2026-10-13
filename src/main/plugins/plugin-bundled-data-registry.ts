import {
  fingerprintPluginConsent,
  fingerprintPluginReview
} from '../../shared/plugins/plugin-consent-fingerprint'
import type { PluginInstallSource } from '../../shared/plugins/plugin-install-lockfile'
import { isPluginApproved } from './plugin-activation-policy'
import type { PluginConsentLists } from '../../shared/plugins/plugin-consent-state'
import { readBundledPluginIndex, resolveBundlePath } from './plugin-bundled-index'
import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'
import { inspectPluginInstallTree } from './plugin-install-staging'
import {
  BUNDLED_SPANISH_PLUGIN_KEY,
  BUNDLED_TYPST_PLUGIN_KEY,
  NO_BUNDLED_DATA_ALIASES,
  type PluginBundledDataAliases
} from '../../shared/plugins/plugin-bundled-data-aliases'
import { isOfficialOrganizationGitSource } from '../../shared/plugins/plugin-marketplace'
import {
  BUNDLED_DATA_PACKS,
  type PluginBundledDataState
} from '../../shared/plugins/plugin-bundled-data-state'

export class PluginBundledDataRegistry {
  private readonly snapshots = new Map<string, ValidDiscoveredPlugin>()
  private failures: DiscoveredPlugin[] = []
  private readonly selected = new Map<string, ValidDiscoveredPlugin>()

  constructor(private readonly options: { root: string; hostVersion: string } | undefined) {}

  async refresh(): Promise<void> {
    this.snapshots.clear()
    this.selected.clear()
    this.failures = []
    if (!this.options) {
      return
    }
    const { root, hostVersion } = this.options
    try {
      const index = await readBundledPluginIndex(root)
      for (const entry of index.plugins) {
        if (entry.activation !== 'bundled-data') {
          continue
        }
        try {
          const rootDir = await resolveBundlePath(root, entry.path)
          const inspection = await inspectPluginInstallTree({
            rootDir,
            hostVersion,
            expectedPluginKey: entry.pluginKey
          })
          if (!inspection.ok) {
            throw new Error(inspection.error)
          }
          const manifest = inspection.manifest
          if (manifest.manifestVersion !== 2 || manifest.execution !== 'data') {
            throw new Error('automatic bundled activation requires a v2 data-only manifest')
          }
          if (inspection.contentHash !== entry.contentHash) {
            throw new Error('bundled data content does not match its release index')
          }
          const consentSource: PluginInstallSource = { kind: 'bundled', bundleId: entry.pluginKey }
          const consentFingerprint = fingerprintPluginConsent(
            manifest,
            entry.contentHash,
            consentSource
          )
          this.snapshots.set(entry.pluginKey, {
            pluginKey: entry.pluginKey,
            rootDir,
            manifest,
            consentFingerprint,
            reviewRevision: fingerprintPluginReview(consentFingerprint, entry.contentHash),
            reviewContentHash: entry.contentHash,
            consentSource,
            consentContentHash: null,
            contentHash: entry.contentHash,
            isDev: false
          })
        } catch (error) {
          this.failures.push({
            pluginKey: entry.pluginKey,
            rootDir: root,
            isDev: false,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
    } catch (error) {
      this.failures.push({
        pluginKey: 'stablyai.orca-bundled-data',
        rootDir: root,
        isDev: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  owns(plugin: ValidDiscoveredPlugin): boolean {
    return this.snapshots.get(plugin.pluginKey) === plugin
  }

  contains(plugin: DiscoveredPlugin): boolean {
    return (
      this.failures.includes(plugin) || (!isInvalidDiscoveredPlugin(plugin) && this.owns(plugin))
    )
  }

  aliases(): PluginBundledDataAliases {
    return this.options ? { locales: ['es'], languages: ['typst'] } : NO_BUNDLED_DATA_ALIASES
  }

  aliasOwner(plugin: ValidDiscoveredPlugin): boolean {
    if (this.owns(plugin)) {
      return true
    }
    if (
      plugin.isDev ||
      !(
        this.snapshots.has(plugin.pluginKey) ||
        (this.options && BUNDLED_DATA_PACKS.some((pack) => pack.pluginKey === plugin.pluginKey))
      ) ||
      plugin.manifest.manifestVersion !== 2 ||
      plugin.manifest.execution !== 'data'
    ) {
      return false
    }
    const source = plugin.consentSource
    return (
      (source?.kind === 'git' && isOfficialOrganizationGitSource(source.url)) ||
      (source?.kind === 'marketplace' && isOfficialOrganizationGitSource(source.plugin.url))
    )
  }

  localeAlias(plugin: ValidDiscoveredPlugin, locale: string): 'es' | undefined {
    return plugin.pluginKey === BUNDLED_SPANISH_PLUGIN_KEY &&
      locale === 'es' &&
      this.aliasOwner(plugin)
      ? 'es'
      : undefined
  }

  syntaxAlias(plugin: ValidDiscoveredPlugin, language: string): 'typst' | undefined {
    return plugin.pluginKey === BUNDLED_TYPST_PLUGIN_KEY &&
      language === 'typst' &&
      this.aliasOwner(plugin)
      ? 'typst'
      : undefined
  }

  states(
    disabled: readonly string[],
    unavailable: (key: string) => boolean
  ): PluginBundledDataState[] {
    if (!this.options) {
      return []
    }
    return BUNDLED_DATA_PACKS.map((pack) => {
      const enabled = !disabled.includes(pack.pluginKey)
      const snapshot = this.snapshots.get(pack.pluginKey)
      const selected = this.selected.get(pack.pluginKey)
      const failed = !selected || unavailable(pack.pluginKey)
      return {
        ...pack,
        enabled,
        source:
          !enabled || failed ? 'unavailable' : selected === snapshot ? 'bundled' : 'installed',
        version: selected?.manifest.version ?? null,
        bundledVersion: snapshot?.manifest.version ?? null,
        unavailable: enabled && failed
      }
    })
  }

  discovery(optional: readonly DiscoveredPlugin[]): DiscoveredPlugin[] {
    const optionalKeys = new Set(
      optional.flatMap((plugin) => (plugin.pluginKey ? [plugin.pluginKey] : []))
    )
    return [
      ...optional,
      ...[...this.snapshots.values(), ...this.failures].filter(
        (plugin) => !plugin.pluginKey || !optionalKeys.has(plugin.pluginKey)
      )
    ]
  }

  content(
    optional: readonly DiscoveredPlugin[],
    enabled: boolean,
    lists: PluginConsentLists,
    disabled: readonly string[] = []
  ): DiscoveredPlugin[] {
    const families = new Set([
      ...this.snapshots.keys(),
      ...(this.options ? BUNDLED_DATA_PACKS.map((pack) => pack.pluginKey) : [])
    ])
    const result = optional.filter((plugin) => !plugin.pluginKey || !families.has(plugin.pluginKey))
    this.selected.clear()
    for (const pluginKey of families) {
      if (disabled.includes(pluginKey)) {
        continue
      }
      const snapshot = this.snapshots.get(pluginKey)
      const override = optional.find(
        (plugin): plugin is ValidDiscoveredPlugin =>
          !isInvalidDiscoveredPlugin(plugin) &&
          !this.owns(plugin) &&
          plugin.pluginKey === pluginKey &&
          plugin.manifest.manifestVersion === 2 &&
          plugin.manifest.execution === 'data' &&
          this.aliasOwner(plugin) &&
          isPluginApproved(enabled, plugin, lists)
      )
      const selected = override ?? snapshot
      if (selected) {
        result.push(selected)
        this.selected.set(pluginKey, selected)
      }
    }
    return result
  }
}
