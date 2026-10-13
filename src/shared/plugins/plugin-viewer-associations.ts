import { z } from 'zod'
import { isQualifiedPluginKey } from './plugin-tab-key'
import { isPluginManifestId } from './plugin-id-format'
import type { PluginViewerMetadata } from './plugin-viewer-package'

export const PLUGIN_VIEWER_ASSOCIATION_LIMIT = 128
export const pluginViewerAssociationSelectorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('extension'),
    value: z
      .string()
      .max(64)
      .regex(/^\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/)
  }),
  z.strictObject({
    kind: z.literal('filename'),
    value: z
      .string()
      .min(1)
      .max(256)
      .refine(
        (value) =>
          value !== '.' &&
          value !== '..' &&
          !/[<>:"/\\|?*]/.test(value) &&
          !Array.from(value).some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
          )
      )
  })
])
export function isPluginViewerKey(value: string): boolean {
  if (!value.startsWith('viewer:')) {
    return false
  }
  const [owner, id, ...extra] = value.slice(7).split('/')
  return (
    extra.length === 0 &&
    Boolean(owner && id && isQualifiedPluginKey(owner) && isPluginManifestId(id))
  )
}
export const pluginViewerChoiceSchema = z.union([
  z.literal('core'),
  z.string().max(512).refine(isPluginViewerKey)
])
export const pluginViewerAssociationSchema = z.strictObject({
  selector: pluginViewerAssociationSelectorSchema,
  viewerKey: pluginViewerChoiceSchema
})
export const pluginViewerAssociationsSchema = z
  .array(pluginViewerAssociationSchema)
  .max(PLUGIN_VIEWER_ASSOCIATION_LIMIT)
export type PluginViewerAssociation = z.infer<typeof pluginViewerAssociationSchema>
export type PluginViewerAssociationSelector = PluginViewerAssociation['selector']

export function viewerFileBasename(filePath: string): string {
  return filePath.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? ''
}
export function normalizePluginViewerAssociations(input: unknown): PluginViewerAssociation[] {
  if (!Array.isArray(input)) {
    return []
  }
  const result: PluginViewerAssociation[] = []
  const seen = new Set<string>()
  for (const entry of input.slice(0, PLUGIN_VIEWER_ASSOCIATION_LIMIT)) {
    const parsed = pluginViewerAssociationSchema.safeParse(entry)
    if (!parsed.success) {
      continue
    }
    const selector = { ...parsed.data.selector, value: parsed.data.selector.value.toLowerCase() }
    const key = JSON.stringify(selector)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push({ ...parsed.data, selector })
  }
  return result
}
export function selectedPluginViewerAssociation(
  associations: readonly PluginViewerAssociation[],
  filePath: string
): PluginViewerAssociation | null {
  const name = viewerFileBasename(filePath)
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
export function defaultPluginViewerSelector(
  filePath: string,
  viewer?: Pick<PluginViewerMetadata, 'selector'>
): PluginViewerAssociationSelector | null {
  const name = viewerFileBasename(filePath)
  const patterns =
    viewer?.selector.map((item) => item.filenamePattern.replace(/^\*\*\//, '').toLowerCase()) ?? []
  if (patterns.includes(name)) {
    const parsed = pluginViewerAssociationSelectorSchema.safeParse({
      kind: 'filename',
      value: name
    })
    return parsed.success ? parsed.data : null
  }
  const suffix = patterns
    .filter((pattern) => pattern.startsWith('*.') && name.endsWith(pattern.slice(1)))
    .map((pattern) => pattern.slice(1))
    .filter(
      (value) =>
        pluginViewerAssociationSelectorSchema.safeParse({ kind: 'extension', value }).success
    )
    .sort((a, b) => b.length - a.length)[0]
  const dot = name.lastIndexOf('.')
  const extension = suffix ?? (dot > 0 ? name.slice(dot) : '')
  const parsed = pluginViewerAssociationSelectorSchema.safeParse({
    kind: 'extension',
    value: extension
  })
  if (parsed.success) {
    return parsed.data
  }
  const filename = pluginViewerAssociationSelectorSchema.safeParse({
    kind: 'filename',
    value: name
  })
  return filename.success ? filename.data : null
}
export function setPluginViewerAssociation(
  associations: readonly PluginViewerAssociation[],
  selector: PluginViewerAssociationSelector,
  viewerKey: string
): PluginViewerAssociation[] {
  const normalizedSelector = pluginViewerAssociationSelectorSchema.parse({
    ...selector,
    value: selector.value.toLowerCase()
  })
  const remaining = normalizePluginViewerAssociations(associations).filter(
    (item) => JSON.stringify(item.selector) !== JSON.stringify(normalizedSelector)
  )
  return viewerKey === 'auto'
    ? remaining
    : normalizePluginViewerAssociations([
        pluginViewerAssociationSchema.parse({ selector: normalizedSelector, viewerKey }),
        ...remaining
      ])
}
