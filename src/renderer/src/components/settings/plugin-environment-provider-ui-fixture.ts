import type { PluginEnvironmentProviderEntry } from '../../../../shared/plugins/plugin-environment-provider-api'

export function environmentProviderUiFixture(): PluginEnvironmentProviderEntry {
  return {
    executionHostId: 'local',
    providerId: 'company.platform/pods',
    pluginKey: 'company.platform',
    name: 'Development machines',
    description: 'Company provider',
    lifetime: 'both',
    protocolVersion: 2,
    actions: ['list', 'create', 'sleep', 'resume', 'archive', 'delete'],
    createFields: [],
    commands: [],
    review: {
      providerId: 'company.platform/pods',
      consentFingerprint: 'sha256-reviewed',
      reviewRevision: 'review-sha256-current',
      recipeDigest: 'a'.repeat(64)
    },
    configuration: { status: 'ready', contextId: 'company/account/region' }
  }
}
