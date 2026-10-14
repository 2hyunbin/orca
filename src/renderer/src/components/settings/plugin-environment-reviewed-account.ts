import type {
  PluginEnvironmentProviderEntry,
  PluginEnvironmentProviderReview
} from '../../../../shared/plugins/plugin-environment-provider-api'

export function reviewedAccount(
  provider: PluginEnvironmentProviderEntry
): PluginEnvironmentProviderReview | null {
  const { configuration } = provider
  return configuration.status === 'ready' || configuration.status === 'migration-required'
    ? { ...provider.review, contextId: configuration.contextId }
    : null
}
