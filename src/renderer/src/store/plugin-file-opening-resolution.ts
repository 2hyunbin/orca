import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { usePluginFileViewerStore, retainPluginFileViewerRegistry } from './plugin-file-viewers'
import { getPluginFileOpeningPlan } from '@/lib/plugin-file-opening-plan'

export function usePluginFileOpeningResolution(): void {
  useEffect(() => {
    let closed = false
    let queued = false
    const schedule = (): void => {
      if (closed || queued) {
        return
      }
      queued = true
      queueMicrotask(() => {
        queued = false
        if (closed) {
          return
        }
        const state = useAppStore.getState()
        const registry = usePluginFileViewerStore.getState()
        for (const file of state.openFiles) {
          if (
            file.mode !== 'file-opening' ||
            file.fileOpeningChoicePending ||
            file.fileOpeningOwnerUnresolved
          ) {
            continue
          }
          const plan = getPluginFileOpeningPlan(file.filePath, state.settings, registry)
          if (
            plan.kind === 'plugin' ||
            (plan.kind === 'core' && !file.pluginViewerUserSelectedFile)
          ) {
            state.resolveFileOpening(file.id, plan.kind === 'core' ? 'core' : plan.viewer.key)
          } else if (plan.kind !== 'loading') {
            useAppStore.setState((current) => ({
              openFiles: current.openFiles.map((item) =>
                item === file ? { ...item, fileOpeningChoicePending: true } : item
              )
            }))
          }
        }
      })
    }
    const stopFiles = useAppStore.subscribe((state, previous) => {
      if (
        state.openFiles !== previous.openFiles ||
        state.settings !== previous.settings ||
        state.repos !== previous.repos ||
        state.worktreesByRepo !== previous.worktreesByRepo ||
        state.folderWorkspaces !== previous.folderWorkspaces ||
        state.runtimeEnvironments !== previous.runtimeEnvironments ||
        state.runtimeEnvironmentCatalogHydrated !== previous.runtimeEnvironmentCatalogHydrated ||
        state.sshStateByEnvironment !== previous.sshStateByEnvironment ||
        state.sshConnectionStates !== previous.sshConnectionStates
      ) {
        schedule()
      }
    })
    const stopMetadata = usePluginFileViewerStore.subscribe(schedule)
    const stopRegistry = retainPluginFileViewerRegistry()
    schedule()
    return () => {
      closed = true
      stopFiles()
      stopMetadata()
      stopRegistry()
    }
  }, [])
}
