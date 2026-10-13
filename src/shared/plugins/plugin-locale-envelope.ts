import { z } from 'zod'
import { pluginLocaleIdSchema } from './plugin-content-pack-contributions'
import {
  PLUGIN_LANGUAGE_CATALOG_MAX_ENTRIES,
  PLUGIN_LANGUAGE_CATALOG_MAX_DEPTH,
  validatePluginLanguagePackCatalog,
  isProtectedPluginTranslationPath
} from './plugin-language-pack-artifact'
import { pluginTranslationPlaceholders, type PluginLocaleKit } from './plugin-locale-kit'

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const entrySchema = z.strictObject({ sourceHash: digestSchema, value: z.string().max(8192) })
export const pluginLocaleEnvelopeSchema = z.strictObject({
  formatVersion: z.literal(1),
  locale: pluginLocaleIdSchema,
  displayName: z.string().min(1).max(128),
  sourceRevision: digestSchema,
  entries: z
    .record(z.string().min(1).max(2048), entrySchema)
    .refine(
      (entries) => Object.keys(entries).length <= PLUGIN_LANGUAGE_CATALOG_MAX_ENTRIES,
      'too many translation entries'
    )
})

export type PluginLocaleEnvelope = z.infer<typeof pluginLocaleEnvelopeSchema>
export type PluginLocaleCoverage = {
  eligible: number
  current: number
  missing: number
  stale: number
  obsolete: number
}

function insertTranslation(catalog: Record<string, unknown>, path: string, value: string): void {
  const parts = path.split('.')
  if (parts.length > PLUGIN_LANGUAGE_CATALOG_MAX_DEPTH + 1) {
    throw new Error('translation key exceeds catalog depth')
  }
  if (
    parts.some(
      (part) =>
        !part ||
        part.length > 128 ||
        ['__proto__', 'constructor', 'prototype'].includes(part) ||
        [...part].some((character) => character.charCodeAt(0) <= 31)
    )
  ) {
    throw new Error(`unsafe translation key: ${path}`)
  }
  let parent = catalog
  for (const part of parts.slice(0, -1)) {
    const child = parent[part]
    if (child === undefined) {
      const next: Record<string, unknown> = {}
      parent[part] = next
      parent = next
    } else if (isTranslationBranch(child)) {
      parent = child
    } else {
      throw new Error(`conflicting translation key: ${path}`)
    }
  }
  const leaf = parts.at(-1)!
  if (parent[leaf] !== undefined) {
    throw new Error(`conflicting translation key: ${path}`)
  }
  parent[leaf] = value
}

function isTranslationBranch(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parsePluginLocaleEnvelope(
  raw: string,
  declaredLocale: string,
  kit: PluginLocaleKit
): {
  catalog: Record<string, unknown>
  envelope: PluginLocaleEnvelope
  coverage: PluginLocaleCoverage
} {
  if (raw.length > 5 * 1024 * 1024 || new TextEncoder().encode(raw).byteLength > 5 * 1024 * 1024) {
    throw new Error('locale envelope exceeds 5 MiB')
  }
  const envelope = pluginLocaleEnvelopeSchema.parse(JSON.parse(raw))
  if (
    Intl.getCanonicalLocales(envelope.locale)[0] !== Intl.getCanonicalLocales(declaredLocale)[0]
  ) {
    throw new Error('locale envelope does not match its manifest declaration')
  }
  const all: Record<string, unknown> = {}
  const effective: Record<string, unknown> = {}
  let current = 0,
    stale = 0,
    obsolete = 0
  for (const [key, entry] of Object.entries(envelope.entries)) {
    if (isProtectedPluginTranslationPath(key)) {
      throw new Error(`catalog cannot replace protected security copy at ${key}`)
    }
    insertTranslation(all, key, entry.value)
    const source = kit.entries[key]
    if (!source) {
      obsolete++
      continue
    }
    if (entry.sourceHash !== source.sourceHash) {
      stale++
      continue
    }
    if (
      JSON.stringify(pluginTranslationPlaceholders(entry.value)) !==
      JSON.stringify(pluginTranslationPlaceholders(source.value))
    ) {
      throw new Error(`translation placeholders do not match at ${key}`)
    }
    insertTranslation(effective, key, entry.value)
    current++
  }
  const structural = validatePluginLanguagePackCatalog(all)
  if (!structural.ok) {
    throw new Error(structural.error)
  }
  const eligible = Object.keys(kit.entries).length
  return {
    catalog: effective,
    envelope,
    coverage: { eligible, current, missing: eligible - current - stale, stale, obsolete }
  }
}

export function createPluginLocaleEnvelope(input: {
  kit: PluginLocaleKit
  locale: string
  displayName: string
  translations: Record<string, string>
}): PluginLocaleEnvelope {
  const entries: PluginLocaleEnvelope['entries'] = {}
  for (const [key, value] of Object.entries(input.translations)) {
    const source = input.kit.entries[key]
    if (!source) {
      throw new Error(`translation has no eligible source key: ${key}`)
    }
    entries[key] = { sourceHash: source.sourceHash, value }
  }
  const envelope = pluginLocaleEnvelopeSchema.parse({
    formatVersion: 1,
    locale: input.locale,
    displayName: input.displayName,
    sourceRevision: input.kit.sourceRevision,
    entries
  })
  parsePluginLocaleEnvelope(JSON.stringify(envelope), input.locale, input.kit)
  return envelope
}
