import { useEffect } from 'react'
import { create } from 'zustand'
import { z } from 'zod'
import {
  NO_BUNDLED_DATA_ALIASES,
  pluginBundledDataAliasesSchema,
  type PluginBundledDataAliases
} from '../../../shared/plugins/plugin-bundled-data-aliases'
import type * as Monaco from 'monaco-editor'
import {
  pluginSyntaxPackMetadataSchema,
  type PluginSyntaxPackMetadata
} from '../../../shared/plugins/plugin-syntax-pack'
import { PluginSyntaxRuntime } from '@/lib/monaco-languages/plugin-syntax-runtime'
import { resolvePluginSyntaxLanguage } from '@/lib/monaco-languages/plugin-syntax-slot-pool'
import { useAppStore } from '@/store'
import { recordPluginSyntaxFailure } from './plugin-syntax-failures'
import {
  selectedPluginSyntaxAssociation,
  type PluginSyntaxAssociation
} from '../../../shared/plugins/plugin-syntax-associations'

type PluginSyntaxState = {
  packs: PluginSyntaxPackMetadata[]
  slots: Record<string, string>
  loaded: boolean
  available: boolean
  aliases: PluginBundledDataAliases
  aliasProtocol: boolean
}

export const usePluginSyntaxStore = create<PluginSyntaxState>()(() => ({
  packs: [],
  slots: {},
  loaded: false,
  available: false,
  aliases: NO_BUNDLED_DATA_ALIASES,
  aliasProtocol: false
}))

let runtime: PluginSyntaxRuntime | undefined
let requestGeneration = 0
let started = false
const packListSchema = z
  .array(pluginSyntaxPackMetadataSchema)
  .max(512)
  .refine((packs) => new Set(packs.map((pack) => pack.pluginKey)).size === packs.length)

async function fetchPluginSyntaxPacks(): Promise<void> {
  const generation = ++requestGeneration
  const available = Boolean(
    window.api?.plugins?.listSyntaxPacks && window.api?.plugins?.loadSyntaxPack
  )
  let packs: PluginSyntaxPackMetadata[] = []
  let aliases = usePluginSyntaxStore.getState().aliases
  let aliasProtocol = false
  try {
    if (available) {
      const [packResult, aliasResult] = await Promise.allSettled([
        window.api.plugins.listSyntaxPacks?.({ bundledDataAliases: true }),
        window.api.plugins.getBundledDataAliases?.().catch(() => null) ?? Promise.resolve(null)
      ])
      const parsedAliases = pluginBundledDataAliasesSchema.safeParse(
        aliasResult.status === 'fulfilled' ? aliasResult.value : null
      )
      aliasProtocol = parsedAliases.success
      if (parsedAliases.success) {
        aliases = parsedAliases.data
      }
      if (packResult.status === 'rejected') {
        throw packResult.reason
      }
      packs = packListSchema.parse(packResult.value)
    }
  } catch {
    packs = []
  }
  if (generation !== requestGeneration) {
    return
  }
  runtime?.replace(packs)
  const slots: Record<string, string> = {}
  for (const key of Object.keys(usePluginSyntaxStore.getState().slots)) {
    const id = runtime?.claim(key)
    if (id) {
      slots[key] = id
    }
  }
  usePluginSyntaxStore.setState({ packs, slots, aliases, aliasProtocol, loaded: true, available })
}

export function installPluginSyntaxRuntime(monaco: typeof Monaco): void {
  if (runtime) {
    return
  }
  runtime = new PluginSyntaxRuntime(
    monaco,
    (pack) =>
      window.api?.plugins?.loadSyntaxPack?.({
        pluginKey: pack.pluginKey,
        revision: pack.revision,
        ...(usePluginSyntaxStore.getState().aliasProtocol
          ? { bundledDataAliases: true as const }
          : {})
      }) ?? Promise.resolve(null),
    (model, failure) => recordPluginSyntaxFailure(model.uri.toString(), failure)
  )
  runtime.replace(usePluginSyntaxStore.getState().packs)
  if (!started) {
    started = true
    void fetchPluginSyntaxPacks()
    window.api?.plugins?.onChanged?.((event) => {
      if (event?.contentPacksChanged ?? true) {
        void fetchPluginSyntaxPacks()
      }
    })
  }
}

export function retryPluginSyntaxModel(modelUri: string): void {
  runtime?.retry(modelUri)
}

const EMPTY_ASSOCIATIONS: readonly PluginSyntaxAssociation[] = []
export function usePluginSyntaxAssociation(filePath: string): PluginSyntaxAssociation | null {
  const associations = useAppStore(
    (state) => state.settings?.pluginSyntaxAssociations ?? EMPTY_ASSOCIATIONS
  )
  return selectedPluginSyntaxAssociation(associations, filePath)
}

export function usePluginSyntaxLanguage(filePath: string, coreLanguage: string): string {
  const packs = usePluginSyntaxStore((state) => state.packs)
  const choice = usePluginSyntaxAssociation(filePath)
  const aliases = usePluginSyntaxStore((state) => state.aliases)
  const key = resolvePluginSyntaxLanguage(packs, filePath, coreLanguage, choice?.languageKey)
  const slot = usePluginSyntaxStore((state) => (key ? state.slots[key] : undefined))
  useEffect(() => {
    if (!key || slot) {
      return
    }
    const id = runtime?.claim(key)
    if (id) {
      usePluginSyntaxStore.setState((state) => ({ slots: { ...state.slots, [key]: id } }))
    }
  }, [key, slot])
  const fallback = aliases.languages.some((alias) => alias === coreLanguage)
    ? 'plaintext'
    : coreLanguage
  return choice?.languageKey === 'plaintext' ? 'plaintext' : (slot ?? fallback)
}
