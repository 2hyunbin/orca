import { z } from 'zod'
import { getRuntimePathBasename } from '../cross-platform-path'
import { pluginIdSchema, pluginRelativePathSchema } from './plugin-manifest-fields'

export const PLUGIN_VIEWER_CONTRIBUTION_LIMIT = 16
export const PLUGIN_VIEWER_SELECTOR_LIMIT = 16
export const PLUGIN_VIEWER_PATTERN_LIMIT = 256
export const PLUGIN_VIEWER_ENTRY_BYTES = 10 * 1024 * 1024

function basenamePattern(pattern: string): string {
  return pattern.startsWith('**/') ? pattern.slice(3) : pattern
}

export function isPluginViewerFilenamePattern(pattern: string): boolean {
  const name = basenamePattern(pattern)
  return (
    pattern.length > 0 &&
    pattern.length <= PLUGIN_VIEWER_PATTERN_LIMIT &&
    name.length > 0 &&
    !Array.from(name).some(
      (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f
    ) &&
    !/[/\\:{}[\]<>]/.test(name) &&
    name !== '.' &&
    name !== '..' &&
    name.split('*').length <= 2
  )
}

export const pluginViewerSelectorSchema = z.strictObject({
  filenamePattern: z.string().refine(isPluginViewerFilenamePattern, 'unsupported filename glob')
})

export const pluginViewerContributionSchema = z.strictObject({
  id: pluginIdSchema,
  displayName: z.string().min(1).max(256),
  selector: z.array(pluginViewerSelectorSchema).min(1).max(PLUGIN_VIEWER_SELECTOR_LIMIT),
  entry: pluginRelativePathSchema.refine(
    (path) => path.endsWith('.js'),
    'requires a bundled .js entry'
  ),
  rendering: z.literal('host-ui'),
  mode: z.literal('readonly')
})

export type PluginViewerContribution = z.infer<typeof pluginViewerContributionSchema>
export type PluginViewerSelector = z.infer<typeof pluginViewerSelectorSchema>

function matchesLiteralPart(pattern: readonly string[], name: readonly string[]): boolean {
  return (
    pattern.length === name.length &&
    pattern.every((character, index) => character === '?' || character === name[index])
  )
}

export function pluginViewerSelectorMatches(
  selector: PluginViewerSelector,
  filePath: string
): boolean {
  if (!isPluginViewerFilenamePattern(selector.filenamePattern)) {
    return false
  }
  const filename = getRuntimePathBasename(filePath)
  if (filename.length > PLUGIN_VIEWER_PATTERN_LIMIT) {
    return false
  }
  const pattern = [...basenamePattern(selector.filenamePattern).toLowerCase()]
  const name = [...filename.toLowerCase()]
  const star = pattern.indexOf('*')
  if (star === -1) {
    return matchesLiteralPart(pattern, name)
  }
  const prefix = pattern.slice(0, star)
  const suffix = pattern.slice(star + 1)
  return (
    name.length >= prefix.length + suffix.length &&
    matchesLiteralPart(prefix, name.slice(0, prefix.length)) &&
    matchesLiteralPart(suffix, name.slice(name.length - suffix.length))
  )
}

export function validatePluginViewerContributions(
  contributions: readonly PluginViewerContribution[],
  context: z.RefinementCtx
): void {
  const identities = new Set<string>()
  for (const [index, viewer] of contributions.entries()) {
    if (identities.has(viewer.id)) {
      context.addIssue({
        code: 'custom',
        path: ['contributes', 'fileViewers', index, 'id'],
        message: 'duplicate viewer id'
      })
    }
    identities.add(viewer.id)
    const selectors = viewer.selector.map((item) => item.filenamePattern.toLowerCase())
    if (new Set(selectors).size !== selectors.length) {
      context.addIssue({
        code: 'custom',
        path: ['contributes', 'fileViewers', index, 'selector'],
        message: 'duplicate viewer selector'
      })
    }
  }
}
