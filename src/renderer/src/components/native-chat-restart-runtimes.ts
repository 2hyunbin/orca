import { useEffect } from 'react'
import { useAppStore } from '../store'
import {
  createNativeChatRestartStore,
  type NativeChatRestartStore
} from './native-chat-resume-on-restart-store'

const stores = new Map<string, NativeChatRestartStore>()

function runtimeStore(environmentId: string): NativeChatRestartStore {
  let store = stores.get(environmentId)
  if (!store) {
    store = createNativeChatRestartStore({ kind: 'environment', environmentId })
    stores.set(environmentId, store)
  }
  return store
}

export function useManagedNativeChatRestartRuntimes() {
  const environments = useAppStore((state) => state.runtimeEnvironments)
  const statuses = useAppStore((state) => state.runtimeStatusByEnvironmentId)
  useEffect(() => {
    const managed = new Set(environments.filter((env) => env.orcadDeployment).map((env) => env.id))
    for (const [id, store] of stores) {
      if (!managed.has(id)) {
        store._resetNativeChatRestartOffer()
        store.consumeNativeChatResumeOnRestartDialogRequest()
        stores.delete(id)
      }
    }
    for (const environment of environments) {
      if (environment.orcadDeployment) {
        runtimeStore(environment.id).observeRuntimeStatus(statuses.get(environment.id))
      }
    }
  }, [environments, statuses])
  return environments
    .filter((environment) => environment.orcadDeployment)
    .map((environment) => ({
      environment,
      store: runtimeStore(environment.id)
    }))
}
