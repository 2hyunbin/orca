import { useRef, useState } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import { usePluginEnvironmentHost } from './plugin-environment-host-context'
import { compactIpcErrorMessage } from '@/lib/ipc-error'

export type ReviewedWorkspaceTarget = { id: string; generation: number }

export function useManagedWorkspaceOpen(onBusy?: (busy: boolean) => void) {
  const { environmentId } = usePluginEnvironmentHost()
  const mounted = useMountedRef()
  const selectedHost = useRef(environmentId)
  selectedHost.current = environmentId
  const busy = useRef(false)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const open = async (resourceId: string, target: ReviewedWorkspaceTarget): Promise<void> => {
    if (busy.current) {
      return
    }
    busy.current = true
    onBusy?.(true)
    setOpeningId(resourceId)
    setError(null)
    const isCurrent = (): boolean => mounted.current && selectedHost.current === environmentId
    try {
      const connect = window.api.runtimeEnvironments.openManagedWorkspace
      if (!connect) {
        throw new Error('Open this managed workspace from the current Orca desktop app.')
      }
      const result = await connect({
        ...(environmentId ? { controllerEnvironmentId: environmentId } : {}),
        sshTargetId: target.id,
        targetGeneration: target.generation
      })
      if (!isCurrent()) {
        return
      }
      const state = useAppStore.getState()
      const environments = await window.api.runtimeEnvironments.list()
      if (!isCurrent()) {
        return
      }
      state.setRuntimeEnvironments(environments)
      if (!(await state.refreshRuntimeEnvironmentStatus(result.environment.id))) {
        throw new Error('The workspace server could not be reached. Reconnect and try again.')
      }
      if (isCurrent()) {
        useAppStore
          .getState()
          .openModal('add-repo', { managedWorkspaceEnvironmentId: result.environment.id })
      }
    } catch (cause) {
      if (isCurrent()) {
        setError(
          compactIpcErrorMessage(cause instanceof Error ? cause.message : '') ??
            'Could not open this workspace. Reconnect and try again.'
        )
      }
    } finally {
      busy.current = false
      if (mounted.current) {
        setOpeningId(null)
        onBusy?.(false)
      }
    }
  }
  return { open, openingId, error }
}
