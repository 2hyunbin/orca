import { useEffect } from 'react'
import { create } from 'zustand'
import {
  NO_BUNDLED_DATA_ALIASES,
  pluginBundledDataAliasesSchema,
  type PluginBundledDataAliases
} from '../../../shared/plugins/plugin-bundled-data-aliases'
import {
  isPluginLanguagePackRegistration,
  type PluginLanguagePackRegistration
} from '../../../shared/plugins/plugin-language-pack-artifact'

type PluginLanguagePackState = {
  packs: PluginLanguagePackRegistration[]
  loaded: boolean
  aliases: PluginBundledDataAliases
  fetchPacks: () => Promise<void>
}

/**
 * Joining the startup request saves a duplicate IPC round trip, but its handler awaits plugin
 * discovery — a wedged one must not turn `ensurePluginLanguagePacksLoaded` into a no-op for the
 * session, which would pin every consumer on built-in translations. Past this bound the pending
 * request is wedged rather than slow, so a later consumer starts its own (mirrors the reasoning in
 * `src/main/git/coalesced-probe.ts`).
 */
const STARTUP_REQUEST_JOIN_WINDOW_MS = 10_000

let requestGeneration = 0
let latestRequestStartedAt: number | null = null
let changeSubscriptionStarted = false

export const usePluginLanguagePackStore = create<PluginLanguagePackState>()((set) => ({
  packs: [],
  loaded: false,
  aliases: NO_BUNDLED_DATA_ALIASES,
  fetchPacks: async () => {
    const generation = ++requestGeneration
    latestRequestStartedAt = Date.now()
    const api = window.api?.plugins
    if (!api?.listLanguagePacks) {
      if (generation === requestGeneration) {
        latestRequestStartedAt = null
        set({ packs: [], aliases: NO_BUNDLED_DATA_ALIASES, loaded: true })
      }
      return
    }
    let aliases = usePluginLanguagePackStore.getState().aliases
    try {
      const [packResult, aliasResult] = await Promise.allSettled([
        api.listLanguagePacks(),
        api.getBundledDataAliases?.().catch(() => null) ?? Promise.resolve(null)
      ])
      const parsedAliases = pluginBundledDataAliasesSchema.safeParse(
        aliasResult.status === 'fulfilled' ? aliasResult.value : null
      )
      if (parsedAliases.success) {
        aliases = parsedAliases.data
      }
      if (packResult.status === 'rejected') {
        throw packResult.reason
      }
      const response = packResult.value
      const packs = Array.isArray(response) ? response.filter(isPluginLanguagePackRegistration) : []
      // Why: a non-array response and a rejected member are different upstream bugs; keep them distinguishable in the log.
      if (!Array.isArray(response)) {
        console.warn(`[plugins] Ignoring non-array language-pack list (${typeof response})`)
      } else if (packs.length !== response.length) {
        console.warn(
          `[plugins] Ignoring ${response.length - packs.length} of ${response.length} malformed language packs`
        )
      }
      if (generation === requestGeneration) {
        set({ packs, aliases, loaded: true })
      }
    } catch {
      if (generation === requestGeneration) {
        set({ packs: [], aliases, loaded: true })
      }
    } finally {
      if (generation === requestGeneration) {
        latestRequestStartedAt = null
      }
    }
  }
}))

export function ensurePluginLanguagePacksLoaded(): void {
  const state = usePluginLanguagePackStore.getState()
  const joinable =
    latestRequestStartedAt !== null &&
    Date.now() - latestRequestStartedAt < STARTUP_REQUEST_JOIN_WINDOW_MS
  if (!state.loaded && !joinable) {
    void state.fetchPacks()
  }
  if (!changeSubscriptionStarted && window.api?.plugins?.onChanged) {
    changeSubscriptionStarted = true
    window.api.plugins.onChanged((event) => {
      if (event?.contentPacksChanged ?? true) {
        void usePluginLanguagePackStore.getState().fetchPacks()
      }
    })
  }
}

export function usePluginLanguagePacks(): PluginLanguagePackRegistration[] {
  const packs = usePluginLanguagePackStore((state) => state.packs)
  useEffect(() => ensurePluginLanguagePacksLoaded(), [])
  return packs
}
