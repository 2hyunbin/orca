import {
  getSshTargetRegistryStore,
  ensureSshConnectionManager
} from '../../ssh/targets/ssh-target-registry'
import type { ManagedHostPortForwardRestoreOptions } from './ssh-managed-port-forward-restore'

export async function restoreSavedSshPortForwards(
  targetId: string,
  options?: ManagedHostPortForwardRestoreOptions
): Promise<void> {
  if (!getSshTargetRegistryStore()?.getTarget(targetId)?.portForwards?.length) {
    return
  }
  try {
    await ensureSshConnectionManager()
    const { restoreManagedHostPortForwards } = await import('./ssh-managed-port-forward-restore')
    await restoreManagedHostPortForwards(targetId, options)
  } catch (error) {
    console.warn(`[ssh] Could not restore port forwards for ${targetId}:`, error)
  }
}
