import { realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { isQualifiedPluginKey } from '../../shared/plugins/plugin-manifest'
import { pluginRelativeDirectorySchema } from '../../shared/plugins/plugin-manifest-fields'
import { isOfficialPluginIdentity } from '../../shared/plugins/plugin-marketplace'
import { readContainedPluginArtifactText } from './plugin-artifact-file-reader'

export const BUNDLED_PLUGIN_INDEX_FILENAME = 'bundled-plugins.json'
const BUNDLED_PLUGIN_INDEX_MAX_BYTES = 64 * 1024

const bundledPluginIndexSchema = z
  .object({
    version: z.literal(1),
    plugins: z
      .array(
        z
          .object({
            pluginKey: z
              .string()
              .refine(isQualifiedPluginKey, 'invalid qualified plugin identity')
              .refine(isOfficialPluginIdentity, 'bundled plugins must use an official identity'),
            path: pluginRelativeDirectorySchema,
            contentHash: z.string().regex(/^[0-9a-f]{64}$/),
            activation: z.literal('bundled-data').optional()
          })
          .strict()
      )
      .max(32)
  })
  .strict()
  .superRefine((index, ctx) => {
    const keys = new Set<string>()
    for (const [entryIndex, plugin] of index.plugins.entries()) {
      if (keys.has(plugin.pluginKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['plugins', entryIndex, 'pluginKey'],
          message: 'duplicate bundled plugin identity'
        })
      }
      keys.add(plugin.pluginKey)
    }
  })

export async function readBundledPluginIndex(
  root: string
): Promise<z.infer<typeof bundledPluginIndexSchema>> {
  const text = await readContainedPluginArtifactText(
    root,
    BUNDLED_PLUGIN_INDEX_FILENAME,
    BUNDLED_PLUGIN_INDEX_MAX_BYTES
  )
  return bundledPluginIndexSchema.parse(JSON.parse(text))
}

export async function resolveBundlePath(root: string, path: string): Promise<string> {
  const [resolvedRoot, resolvedPath] = await Promise.all([
    realpath(root),
    realpath(join(root, path))
  ])
  const fromRoot = relative(resolvedRoot, resolvedPath)
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('bundled plugin path escapes the resource root')
  }
  return resolvedPath
}
