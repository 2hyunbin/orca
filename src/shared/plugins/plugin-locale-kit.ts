import { createHash } from 'node:crypto'
import {
  PLUGIN_LANGUAGE_CATALOG_MAX_ENTRIES,
  PLUGIN_LANGUAGE_CATALOG_MAX_DEPTH,
  isProtectedPluginTranslationPath
} from './plugin-language-pack-artifact'

export type PluginLocaleKitEntry = { sourceHash: string; value: string }
export type PluginLocaleKit = {
  formatVersion: 1
  sourceRevision: string
  entries: Record<string, PluginLocaleKitEntry>
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export function pluginTranslationPlaceholders(value: string): string[] {
  return [...new Set(value.match(/\{\{[^}]+\}\}/g) ?? [])].sort()
}

export function createPluginLocaleKit(source: Record<string, unknown>): PluginLocaleKit {
  const entries: Record<string, PluginLocaleKitEntry> = {}
  let visitedEntries = 0
  const seen = new WeakSet<object>()
  const visit = (catalog: Record<string, unknown>, prefix: string, depth = 0): void => {
    if (
      depth > PLUGIN_LANGUAGE_CATALOG_MAX_DEPTH ||
      seen.has(catalog) ||
      Object.getPrototypeOf(catalog) !== Object.prototype
    ) {
      throw new Error('invalid or deeply nested source catalog')
    }
    seen.add(catalog)
    for (const key of Object.keys(catalog).sort()) {
      if (++visitedEntries > PLUGIN_LANGUAGE_CATALOG_MAX_ENTRIES) {
        throw new Error('source catalog exceeds entry limit')
      }
      if (
        key
          .split('.')
          .some((part) => !part || ['__proto__', 'constructor', 'prototype'].includes(part))
      ) {
        throw new Error('unsafe source key')
      }
      const path = prefix ? `${prefix}.${key}` : key
      const value = catalog[key]
      if (typeof value === 'string' && !isProtectedPluginTranslationPath(path)) {
        entries[path] = {
          value,
          sourceHash: digest(JSON.stringify([path, value, pluginTranslationPlaceholders(value)]))
        }
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        if (isSourceBranch(value)) {
          visit(value, path, depth + 1)
        }
      }
    }
  }
  visit(source, '')
  return { formatVersion: 1, sourceRevision: digest(JSON.stringify(entries)), entries }
}

export function diffPluginLocaleKits(
  previous: PluginLocaleKit,
  current: PluginLocaleKit
): {
  added: string[]
  changed: string[]
  removed: string[]
} {
  const keys = Object.keys(current.entries).sort()
  return {
    added: keys.filter((key) => !previous.entries[key]),
    changed: keys.filter(
      (key) =>
        previous.entries[key] &&
        previous.entries[key]?.sourceHash !== current.entries[key]?.sourceHash
    ),
    removed: Object.keys(previous.entries)
      .sort()
      .filter((key) => !current.entries[key])
  }
}

function isSourceBranch(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
