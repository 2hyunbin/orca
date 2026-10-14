import type { PluginEnvironmentProviderReview } from '../../shared/plugins/plugin-environment-provider-api'
import type { PluginEnvironmentProviderSshOptions } from './plugin-environment-provider-ssh-reviews'

export async function findCurrentEnvironmentProviderSshResource(
  options: Pick<PluginEnvironmentProviderSshOptions, 'inventory'>,
  review: PluginEnvironmentProviderReview,
  id: string,
  signal?: AbortSignal
) {
  let cursor: string | undefined
  const seen = new Set<string>()
  for (let page = 0; page < 16; page += 1) {
    const result = await options.inventory(review, cursor, signal)
    if (
      result.kind !== 'executed' ||
      result.result.kind !== 'completed' ||
      result.result.response.kind !== 'inventory'
    ) {
      throw new Error('The provider did not confirm current machine connection details')
    }
    const resource = result.result.response.resources.find((entry) => entry.id === id)
    if (resource) {
      return resource
    }
    cursor = result.result.response.nextCursor
    if (!cursor) {
      return undefined
    }
    if (seen.has(cursor)) {
      throw new Error('The provider repeated an inventory page')
    }
    seen.add(cursor)
  }
  throw new Error('The provider inventory exceeds the connection review page limit')
}
