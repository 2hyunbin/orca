import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { getPreferredPairedRuntimeConnection } from '../../shared/runtime-environments'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { getRuntimeEnvironmentCapabilityIncarnation } from './runtime-environment-capability-evidence'
import { getRuntimeEnvironmentStatusOwner } from './runtime-environment-request-connections'
import { isRuntimeEnvironmentManuallyDisconnected } from './runtime-environment-manual-disconnect'
import {
  runtimeEnvironmentChangedFailure,
  runtimeEnvironmentRevisionFailure
} from './runtime-environment-revision-guard'
import { attachRemoteControlDiagnostics } from './runtime-environment-status-diagnostics'
import { withTailscaleHintForResponse } from './runtime-environment-tailscale-response'

export async function getRuntimeEnvironmentStatus(
  userDataPath: string,
  selector: string,
  timeoutMs?: number,
  options?: {
    observeOnly?: true
    signal?: AbortSignal
    reconnect?: true
    expectedEnvironmentPairingRevision?: number
  }
): Promise<RuntimeRpcResponse<RuntimeStatus>> {
  const environment = resolveEnvironment(userDataPath, selector)
  const admissionFailure = runtimeEnvironmentRevisionFailure(
    environment,
    options?.expectedEnvironmentPairingRevision,
    'status.get'
  )
  if (admissionFailure) {
    return admissionFailure
  }
  if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
    return {
      id: 'status.get',
      ok: false,
      error: {
        code: 'runtime_manually_disconnected',
        message: 'Runtime environment is manually disconnected.'
      }
    }
  }
  const incarnation = getRuntimeEnvironmentCapabilityIncarnation(environment.id)
  const response = await getRuntimeEnvironmentStatusOwner(userDataPath, environment.id).refresh({
    timeoutMs,
    ...options
  })
  const acceptanceFailure = runtimeEnvironmentRevisionFailure(
    options?.expectedEnvironmentPairingRevision === undefined
      ? environment
      : resolveEnvironment(userDataPath, environment.id),
    options?.expectedEnvironmentPairingRevision,
    'status.get'
  )
  if (acceptanceFailure) {
    return acceptanceFailure
  }
  // A retired request must not publish old status or borrow its replacement's diagnostics.
  if (getRuntimeEnvironmentCapabilityIncarnation(environment.id) !== incarnation) {
    return runtimeEnvironmentChangedFailure(environment, 'status.get')
  }
  return attachRemoteControlDiagnostics(
    withTailscaleHintForResponse(
      response,
      getPreferredPairedRuntimeConnection(environment).endpoint
    ),
    environment.id
  )
}
