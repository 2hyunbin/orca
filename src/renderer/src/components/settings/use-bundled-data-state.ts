import { usePluginCatalogApi } from './plugin-catalog-host-context'
import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import {
  pluginBundledDataStateSchema,
  type PluginBundledDataState
} from '../../../../shared/plugins/plugin-bundled-data-state'

const statesSchema = z
  .array(pluginBundledDataStateSchema)
  .max(2)
  .refine((states) => new Set(states.map((state) => state.pluginKey)).size === states.length)

export function useBundledDataState(mounted: boolean) {
  const api = usePluginCatalogApi()
  const [packs, setPacks] = useState<PluginBundledDataState[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const owner = useRef({ generation: 0 })
  const request = useRef(0)
  const available = Boolean(api?.listBundledData)

  const refresh = useCallback(async (): Promise<void> => {
    const generation = owner.current.generation
    const requestId = ++request.current
    try {
      const response = (await api.listBundledData?.()) ?? []
      const states = statesSchema.parse(response)
      if (generation === owner.current.generation && requestId === request.current) {
        setPacks(states)
        setFailed(false)
      }
    } catch {
      if (generation === owner.current.generation && requestId === request.current) {
        setFailed(true)
      }
    } finally {
      if (generation === owner.current.generation && requestId === request.current) {
        setLoading(false)
      }
    }
  }, [api])

  useEffect(() => {
    const lifetime = owner.current
    lifetime.generation++
    if (mounted) {
      void refresh()
      const unsubscribe = api?.onChanged?.((event) => {
        if (event?.contentPacksChanged ?? true) {
          void refresh()
        }
      })
      return () => {
        lifetime.generation++
        unsubscribe?.()
      }
    }
    setPacks([])
    setLoading(true)
    setFailed(false)
    setBusy(new Set())
    return () => {
      lifetime.generation++
    }
  }, [mounted, api, refresh])

  const toggle = async (pack: PluginBundledDataState): Promise<void> => {
    if (busy.has(pack.pluginKey) || !api.setBundledDataEnabled) {
      return
    }
    const generation = owner.current.generation
    setBusy((current) => new Set([...current, pack.pluginKey]))
    try {
      await api.setBundledDataEnabled({
        pluginKey: pack.pluginKey,
        enabled: !pack.enabled
      })
      if (generation === owner.current.generation) {
        await refresh()
      }
    } catch {
      if (generation === owner.current.generation) {
        setFailed(true)
      }
    } finally {
      if (generation === owner.current.generation) {
        setBusy((current) => new Set([...current].filter((key) => key !== pack.pluginKey)))
      }
    }
  }
  const retry = async (): Promise<void> => {
    const generation = owner.current.generation
    try {
      await api.refresh()
      if (generation === owner.current.generation) {
        await refresh()
      }
    } catch {
      if (generation === owner.current.generation) {
        setFailed(true)
      }
    }
  }
  return { packs, loading, failed, busy, available, refresh, retry, toggle }
}
