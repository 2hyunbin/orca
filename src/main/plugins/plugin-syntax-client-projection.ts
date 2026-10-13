import type {
  PluginSyntaxPackMetadata,
  PluginSyntaxPackPayload
} from '../../shared/plugins/plugin-syntax-pack'

export function projectLegacyPluginSyntaxMetadata(
  pack: PluginSyntaxPackMetadata
): PluginSyntaxPackMetadata {
  return {
    ...pack,
    languages: pack.languages.map(({ builtInLanguage: _alias, ...language }) => language)
  }
}

export function projectLegacyPluginSyntaxPayload(
  pack: PluginSyntaxPackPayload
): PluginSyntaxPackPayload {
  return {
    ...pack,
    languages: pack.languages.map(({ builtInLanguage: _alias, ...language }) => language)
  }
}
