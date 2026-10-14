import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { getPreferredPairedRuntimeConnection } from '../../shared/runtime-environments'
import { resolveManagedRuntimeEnvironment } from './runtime-environment-managed-tunnel'
import { isRuntimeEnvironmentManuallyDisconnected } from './runtime-environment-manual-disconnect'
import { runtimeEnvironmentRevisionFailure } from './runtime-environment-revision-guard'
import {
  getRuntimeEnvironmentTransportGeneration,
  onRuntimeEnvironmentTransportChanged
} from './runtime-environment-transport-generation'

export class RuntimeEnvironmentConnectionChangedError extends Error {
  constructor() {
    super('The selected host or pairing changed')
  }
}

export async function prepareRuntimeEnvironmentConnectionLease(
  userDataPath: string,
  expected: { environmentId: string; pairingRevision: number; runtimeId: string },
  onInvalidated: () => void,
  signal?: AbortSignal
) {
  const environment = resolveEnvironment(userDataPath, expected.environmentId)
  const generation = getRuntimeEnvironmentTransportGeneration(environment.id)
  let fingerprint: string | null = null
  let retired = false
  const isCurrent = (): boolean => {
    try {
      const current = resolveEnvironment(userDataPath, environment.id)
      return (
        !retired &&
        !signal?.aborted &&
        !isRuntimeEnvironmentManuallyDisconnected(environment.id) &&
        getRuntimeEnvironmentTransportGeneration(environment.id) === generation &&
        (fingerprint === null ||
          JSON.stringify(getPreferredPairedRuntimeConnection(current)) === fingerprint) &&
        !runtimeEnvironmentRevisionFailure(
          current,
          expected.pairingRevision,
          'plugins.review',
          expected.runtimeId
        )
      )
    } catch {
      return false
    }
  }
  const invalidate = (): void => {
    if (retired) {return}
    close()
    onInvalidated()
  }
  const stop = onRuntimeEnvironmentTransportChanged(environment.id, invalidate)
  const close = (): void => {
    retired = true
    stop()
    signal?.removeEventListener('abort', invalidate)
  }
  signal?.addEventListener('abort', invalidate, { once: true })
  try {
    if (!isCurrent()) {throw new RuntimeEnvironmentConnectionChangedError()}
    const prepared = await resolveManagedRuntimeEnvironment(userDataPath, environment.id)
    if (!isCurrent()) {throw new RuntimeEnvironmentConnectionChangedError()}
    const pairing = getPreferredPairedRuntimeConnection(prepared)
    fingerprint = JSON.stringify(pairing)
    if (!isCurrent()) {throw new RuntimeEnvironmentConnectionChangedError()}
    return { pairing, isCurrent, close }
  } catch (error) {
    close()
    throw error
  }
}
