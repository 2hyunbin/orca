import { removeSshTargetRegistration } from '../ssh/ssh-target-transport'

export {
  disconnectRegisteredSshTarget,
  teardownSshTargetTransport,
  abandonDecisionTransport
} from '../ssh/ssh-target-transport'

export async function removeRegisteredSshTarget(targetId: string): Promise<void> {
  await removeSshTargetRegistration(targetId, async (targetId) => {
    const [partitions, storage] = await Promise.all([
      import('../browser/local-ssh-browser-partitions'),
      import('../browser/browser-route-partition-storage-runtime')
    ])
    await partitions.releaseLocalSshBrowserPartitionsForTarget(targetId)
    await storage.clearBrowserRoutePartitionStorageForLocalSshTarget(targetId)
    // Why (review P2-2): a prepare racing the removal can re-register between
    // release and clear; one delayed second pass reclaims what slipped
    // through (mirrors the environment-removal retry).
    await new Promise((resolve) => setTimeout(resolve, 500))
    await partitions.releaseLocalSshBrowserPartitionsForTarget(targetId)
    await storage.clearBrowserRoutePartitionStorageForLocalSshTarget(targetId)
  })
}
