import { createContext, useContext } from 'react'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
import type { PluginEnvironmentHostApi } from '@/runtime/plugin-environment-provider-client-api'
export type { PluginEnvironmentHostApi } from '@/runtime/plugin-environment-provider-client-api'

export type PluginEnvironmentHost = {
  api: PluginEnvironmentHostApi
  hostLabel: string
  isRemote: boolean
  environmentId?: string
}
export const PluginEnvironmentHostContext = createContext<PluginEnvironmentHost | null>(null)

export function usePluginEnvironmentHost(): PluginEnvironmentHost {
  return (
    useContext(PluginEnvironmentHostContext) ?? {
      api: window.api.plugins,
      hostLabel: getLocalExecutionHostLabel(),
      isRemote: false
    }
  )
}

export function usePluginEnvironmentHostLabel(): string {
  return useContext(PluginEnvironmentHostContext)?.hostLabel ?? getLocalExecutionHostLabel()
}
