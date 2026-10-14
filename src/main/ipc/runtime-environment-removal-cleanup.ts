import { clearBrowserRoutePartitionStorageForEnvironment } from '../browser/browser-route-partition-storage-runtime'
import { retireBrowserRoutePartitionStorageForEnvironment } from '../browser/browser-route-partition-storage-retirement'
import {
  retireRuntimeEnvironmentState,
  type RemovedServerStore
} from '../runtime/runtime-environment-retirement'
export type { RemovedServerStore } from '../runtime/runtime-environment-retirement'

export function retireRemovedRuntimeEnvironment(
  environmentId: string,
  invalidateTransport: (environmentId: string) => Promise<void> | void,
  store: RemovedServerStore
): Promise<void> {
  const retiring = retireRuntimeEnvironmentState(environmentId, invalidateTransport, store)
  // Why: removal is an explicit lifecycle decision, so its client-hosted browser storage goes
  // too -- but only once the client host releases its partitions, or every one refuses as live.
  void retireBrowserRoutePartitionStorageForEnvironment({
    environmentId,
    whenClientHostClosed: retiring,
    clearStorage: clearBrowserRoutePartitionStorageForEnvironment,
    onError: (error) => {
      console.warn('[runtime-environments] browser partition storage clear failed:', error)
    }
  }).catch((error) => {
    console.warn('[runtime-environments] browser partition storage clear failed:', error)
  })
  return retiring
}
