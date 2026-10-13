import { z } from 'zod'
import { BUNDLED_SPANISH_PLUGIN_KEY, BUNDLED_TYPST_PLUGIN_KEY } from './plugin-bundled-data-aliases'

export const bundledDataPluginKeySchema = z.enum([
  BUNDLED_SPANISH_PLUGIN_KEY,
  BUNDLED_TYPST_PLUGIN_KEY
])
export const disabledBundledDataPluginsSchema = z.array(bundledDataPluginKeySchema).max(2)
export function normalizeDisabledBundledDataPlugins(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.filter((key): key is string => bundledDataPluginKeySchema.safeParse(key).success)
        )
      ]
    : []
}

export const pluginBundledDataStateSchema = z.strictObject({
  pluginKey: bundledDataPluginKeySchema,
  name: z.enum(['Spanish', 'Typst syntax']),
  type: z.enum(['locale', 'syntax']),
  enabled: z.boolean(),
  source: z.enum(['bundled', 'installed', 'unavailable']),
  version: z.string().min(1).max(128).nullable(),
  bundledVersion: z.string().min(1).max(128).nullable(),
  unavailable: z.boolean()
})
export type PluginBundledDataState = z.infer<typeof pluginBundledDataStateSchema>

export const BUNDLED_DATA_PACKS = [
  { pluginKey: BUNDLED_SPANISH_PLUGIN_KEY, name: 'Spanish', type: 'locale' },
  { pluginKey: BUNDLED_TYPST_PLUGIN_KEY, name: 'Typst syntax', type: 'syntax' }
] as const
