import { useEffect } from 'react'
import { create } from 'zustand'
import { z } from 'zod'
import {
  pluginViewerMetadataSchema,
  type PluginViewerMetadata
} from '../../../shared/plugins/plugin-viewer-package'
import {
  pluginSyntaxPackMetadataSchema,
  type PluginSyntaxPackMetadata
} from '../../../shared/plugins/plugin-syntax-pack'

const viewersSchema = z
  .array(pluginViewerMetadataSchema)
  .max(512)
  .refine((viewers) => new Set(viewers.map((viewer) => viewer.key)).size === viewers.length)
export type PluginFileViewerRegistry = {
  status: 'idle' | 'loading' | 'ready' | 'failed' | 'unsupported'
  viewers: PluginViewerMetadata[]
  syntaxPacks: PluginSyntaxPackMetadata[]
}
export const usePluginFileViewerStore = create<PluginFileViewerRegistry>(() => ({
  status: 'idle',
  viewers: [],
  syntaxPacks: []
}))
const syntaxSchema = z
  .array(pluginSyntaxPackMetadataSchema)
  .max(512)
  .refine((items) => new Set(items.map((item) => item.pluginKey)).size === items.length)
let readers = 0
let generation = 0
let unsubscribe: (() => void) | undefined
export async function refreshPluginFileViewers(): Promise<void> {
  const request = ++generation
  const available = Boolean(window.api?.plugins?.listFileViewers)
  usePluginFileViewerStore.setState({
    status: available ? 'loading' : 'unsupported',
    viewers: [],
    syntaxPacks: []
  })
  if (!available) {
    return
  }
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const metadata = Promise.all([
      window.api.plugins.listFileViewers?.(),
      window.api.plugins.listSyntaxPacks?.() ?? []
    ])
    const [viewers, syntaxPacks] = await Promise.race([
      metadata,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('viewer metadata timeout')), 5000)
      })
    ])
    const parsed = {
      viewers: viewersSchema.parse(viewers),
      syntaxPacks: syntaxSchema.parse(syntaxPacks)
    }
    if (request === generation && readers > 0) {
      usePluginFileViewerStore.setState({ ...parsed, status: 'ready' })
    }
  } catch {
    if (request === generation && readers > 0) {
      usePluginFileViewerStore.setState({ status: 'failed', viewers: [], syntaxPacks: [] })
    }
  } finally {
    clearTimeout(deadline)
  }
}
export function retainPluginFileViewerRegistry(): () => void {
  if (++readers === 1) {
    unsubscribe = window.api?.plugins?.onChanged?.(() => {
      void refreshPluginFileViewers()
    })
    void refreshPluginFileViewers()
  }
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    if (--readers === 0) {
      generation++
      unsubscribe?.()
      unsubscribe = undefined
      usePluginFileViewerStore.setState({ status: 'idle', viewers: [], syntaxPacks: [] })
    }
  }
}
export function usePluginFileViewerRegistry(): void {
  useEffect(() => retainPluginFileViewerRegistry(), [])
}
export function usePluginFileViewers(): PluginViewerMetadata[] {
  usePluginFileViewerRegistry()
  return usePluginFileViewerStore((state) => state.viewers)
}
