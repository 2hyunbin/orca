import { parsePluginLanguagePackArtifact } from '../../shared/plugins/plugin-language-pack-artifact'
import {
  parsePluginLocaleEnvelope,
  type PluginLocaleCoverage
} from '../../shared/plugins/plugin-locale-envelope'
import { getPluginLocaleKit } from './plugin-locale-source'

export async function parsePluginLocaleContent(
  text: string,
  locale: string,
  manifestVersion: 1 | 2
): Promise<{
  catalog: Record<string, unknown>
  displayName?: string
  coverage?: PluginLocaleCoverage
}> {
  if (manifestVersion === 2) {
    const result = parsePluginLocaleEnvelope(text, locale, await getPluginLocaleKit())
    return {
      catalog: result.catalog,
      displayName: result.envelope.displayName,
      coverage: result.coverage
    }
  }
  const result = parsePluginLanguagePackArtifact(text)
  if (!result.ok) {
    throw new Error(result.error)
  }
  return { catalog: result.catalog }
}
