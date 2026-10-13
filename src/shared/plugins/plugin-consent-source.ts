import type { PluginInstallSource } from './plugin-install-lockfile'

export function canonicalizePluginConsentSource(source: PluginInstallSource): string {
  switch (source.kind) {
    case 'local-path':
      return JSON.stringify(['local-path', source.path])
    case 'git':
      return JSON.stringify(['git', source.url])
    case 'bundled':
      return JSON.stringify(['bundled', source.bundleId])
    case 'marketplace':
      return JSON.stringify([
        'marketplace',
        source.marketplace.url,
        source.marketplace.ref,
        source.marketplace.owner ?? null,
        source.plugin.url
      ])
  }
}
