import type { DaemonAsyncIoStatus } from '../../shared/daemon-async-io-health'
import { getAllDaemonAdapters } from './daemon-provider-routing'
import { getDaemonProvider } from './daemon-provider-state'

export async function readDaemonProviderAsyncIoHealth(): Promise<DaemonAsyncIoStatus> {
  const provider = getDaemonProvider()
  if (!provider) {
    return { state: 'unverifiable' }
  }
  const results = new Map(
    await Promise.all(
      getAllDaemonAdapters(provider).map(async (adapter) => {
        const identity = adapter.getDaemonIdentity()
        const health = await adapter
          .getAsyncIoHealth()
          .catch((): DaemonAsyncIoStatus => ({ state: 'unverifiable' }))
        return [adapter, { identity, health }] as const
      })
    )
  )
  if (getDaemonProvider() !== provider) {
    return { state: 'unverifiable' }
  }
  const health = getAllDaemonAdapters(provider).map((adapter): DaemonAsyncIoStatus => {
    const result = results.get(adapter)
    // Removed owners cannot warn; new or replaced owners cannot inherit health evidence.
    return result?.identity && result.identity === adapter.getDaemonIdentity()
      ? result.health
      : { state: 'unverifiable' }
  })
  const stalled = health.find((result) => result.state === 'stalled')
  if (stalled) {
    return stalled
  }
  if (health.length === 0 || health.some((result) => result.state === 'unverifiable')) {
    return { state: 'unverifiable' }
  }
  if (health.some((result) => result.state === 'unsupported')) {
    return { state: 'unsupported' }
  }
  return {
    state: 'healthy',
    pendingMs: Math.max(
      ...health.map((result) => (result.state === 'healthy' ? result.pendingMs : 0))
    )
  }
}
