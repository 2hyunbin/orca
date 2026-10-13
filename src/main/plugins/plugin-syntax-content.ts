import type { PluginManifest } from '../../shared/plugins/plugin-manifest'
import {
  PLUGIN_SYNTAX_CONFIGURATION_MAX_BYTES,
  PLUGIN_SYNTAX_GRAMMAR_MAX_BYTES,
  PLUGIN_SYNTAX_TOTAL_MAX_BYTES
} from '../../shared/plugins/plugin-syntax-contributions'
import {
  parsePluginGrammarArtifact,
  parsePluginLanguageConfiguration,
  validatePluginGrammarIncludes
} from '../../shared/plugins/plugin-syntax-artifact'
import type { PluginGrammarArtifact } from '../../shared/plugins/plugin-syntax-artifact'
import type { PluginSyntaxLanguageContent } from '../../shared/plugins/plugin-syntax-pack'

export async function readPluginSyntaxContent(
  manifest: PluginManifest,
  readText: (path: string, maxBytes: number) => Promise<string>
) {
  if (manifest.manifestVersion !== 2) {
    return { languages: [], grammars: [] }
  }
  let total = 0
  const grammars: PluginGrammarArtifact[] = []
  for (const contribution of manifest.contributes.grammars) {
    const text = await readText(contribution.path, PLUGIN_SYNTAX_GRAMMAR_MAX_BYTES)
    total += Buffer.byteLength(text, 'utf8')
    if (total > PLUGIN_SYNTAX_TOTAL_MAX_BYTES) {
      throw new Error('grammar data exceeds the package byte limit')
    }
    grammars.push(parsePluginGrammarArtifact(text, contribution.scopeName))
  }
  validatePluginGrammarIncludes(grammars)
  const sources = grammars.map((grammar) => ({
    scopeName: grammar.scopeName,
    content: JSON.stringify(grammar)
  }))
  const languages: PluginSyntaxLanguageContent[] = []
  for (const language of manifest.contributes.languages) {
    const grammar = manifest.contributes.grammars.find((item) => item.language === language.id)
    if (!grammar) {
      throw new Error('syntax language requires a grammar')
    }
    const configuration = language.configuration
      ? parsePluginLanguageConfiguration(
          await readText(language.configuration, PLUGIN_SYNTAX_CONFIGURATION_MAX_BYTES)
        )
      : {}
    languages.push({ ...language, configuration, scopeName: grammar.scopeName })
  }
  return { languages, grammars: sources }
}
