import { z } from 'zod'
import { isPluginManifestId } from './plugin-id-format'
import { isQualifiedPluginKey } from './plugin-tab-key'
import { pluginSyntaxLanguageSchema } from './plugin-syntax-contributions'

export const PLUGIN_SYNTAX_ASSOCIATION_LIMIT = 128
export function isPluginSyntaxLanguageKey(value: string): boolean {
  if (!value.startsWith('syntax:')) {
    return false
  }
  const [owner, language, ...extra] = value.slice(7).split('/')
  return (
    extra.length === 0 &&
    Boolean(owner && language && isQualifiedPluginKey(owner) && isPluginManifestId(language))
  )
}
export const pluginSyntaxChoiceSchema = z.union([
  z.enum(['auto', 'plaintext']),
  z.string().max(256).refine(isPluginSyntaxLanguageKey)
])
const selectorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('extension'),
    value: pluginSyntaxLanguageSchema.shape.extensions.unwrap().element
  }),
  z.strictObject({
    kind: z.literal('filename'),
    value: pluginSyntaxLanguageSchema.shape.filenames.unwrap().element
  })
])
export const pluginSyntaxAssociationSchema = z.strictObject({
  selector: selectorSchema,
  languageKey: pluginSyntaxChoiceSchema
})
export const pluginSyntaxAssociationsSchema = z
  .array(pluginSyntaxAssociationSchema)
  .max(PLUGIN_SYNTAX_ASSOCIATION_LIMIT)
export type PluginSyntaxAssociation = z.infer<typeof pluginSyntaxAssociationSchema>
export type PluginSyntaxSelector = PluginSyntaxAssociation['selector']

export function normalizePluginSyntaxAssociations(input: unknown): PluginSyntaxAssociation[] {
  if (!Array.isArray(input)) {
    return []
  }
  const result: PluginSyntaxAssociation[] = []
  const seen = new Set<string>()
  for (const candidate of input.slice(0, PLUGIN_SYNTAX_ASSOCIATION_LIMIT)) {
    const parsed = pluginSyntaxAssociationSchema.safeParse(candidate)
    if (!parsed.success || parsed.data.languageKey === 'auto') {
      continue
    }
    const selector = { ...parsed.data.selector, value: parsed.data.selector.value.toLowerCase() }
    const id = JSON.stringify(selector)
    if (!seen.has(id)) {
      seen.add(id)
      result.push({ ...parsed.data, selector })
    }
  }
  return result
}

export function syntaxFileBasename(filePath: string): string {
  return filePath.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? ''
}

export function selectedPluginSyntaxAssociation(
  associations: readonly PluginSyntaxAssociation[],
  filePath: string
): PluginSyntaxAssociation | null {
  const name = syntaxFileBasename(filePath)
  return (
    associations.find(
      (item) => item.selector.kind === 'filename' && item.selector.value === name
    ) ??
    associations
      .filter((item) => item.selector.kind === 'extension' && name.endsWith(item.selector.value))
      .sort((a, b) => b.selector.value.length - a.selector.value.length)[0] ??
    null
  )
}

export function defaultPluginSyntaxSelector(
  filePath: string,
  extensions: readonly string[]
): PluginSyntaxSelector {
  const name = syntaxFileBasename(filePath)
  const declared = extensions
    .filter((extension) => name.endsWith(extension.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0]
  if (declared) {
    return { kind: 'extension', value: declared.toLowerCase() }
  }
  const index = name.lastIndexOf('.')
  const extension = index > 0 ? name.slice(index) : ''
  if (selectorSchema.safeParse({ kind: 'extension', value: extension }).success) {
    return { kind: 'extension', value: extension }
  }
  return { kind: 'filename', value: name }
}

export function setPluginSyntaxAssociation(
  associations: readonly PluginSyntaxAssociation[],
  selector: PluginSyntaxSelector,
  languageKey: string
): PluginSyntaxAssociation[] {
  const choice = pluginSyntaxAssociationSchema.parse({ selector, languageKey })
  const normalizedSelector = { ...choice.selector, value: choice.selector.value.toLowerCase() }
  const remaining = associations.filter(
    (item) => JSON.stringify(item.selector) !== JSON.stringify(normalizedSelector)
  )
  return normalizePluginSyntaxAssociations(
    choice.languageKey === 'auto'
      ? remaining
      : [{ ...choice, selector: normalizedSelector }, ...remaining]
  )
}
