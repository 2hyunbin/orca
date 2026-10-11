import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { RuntimeRpcFailure } from '../../shared/runtime-rpc-envelope'
import type { RemoteRuntimeSendValidation } from '../../shared/remote-runtime-client'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import {
  isRuntimeEnvironmentCapabilityOutcomeCurrent,
  type RuntimeEnvironmentCapabilityOutcome
} from './runtime-environment-capability-evidence'

export function runtimeEnvironmentRevisionFailure(
  environment: KnownRuntimeEnvironment,
  expectedPairingRevision: number | undefined,
  method: string,
  expectedRuntimeId?: string,
  verifiedRuntimeId?: string | null
): RuntimeRpcFailure | null {
  const pairingChanged =
    expectedPairingRevision !== undefined &&
    (environment.pairingRevision ?? environment.createdAt) !== expectedPairingRevision
  const runtimeChanged =
    expectedRuntimeId !== undefined &&
    (environment.runtimeId !== expectedRuntimeId ||
      (verifiedRuntimeId !== undefined && verifiedRuntimeId !== expectedRuntimeId))
  if (!pairingChanged && !runtimeChanged) {
    return null
  }
  return runtimeEnvironmentChangedFailure(environment, method, pairingChanged)
}

export function runtimeEnvironmentChangedFailure(
  environment: Pick<KnownRuntimeEnvironment, 'runtimeId'>,
  method: string,
  pairingChanged = false
): RuntimeRpcFailure {
  return {
    id: method,
    ok: false,
    error: {
      code: 'runtime_environment_changed',
      message: pairingChanged
        ? 'Runtime environment pairing changed; refresh and try again'
        : 'Runtime environment identity changed; refresh and try again'
    },
    _meta: { runtimeId: environment.runtimeId }
  }
}

export function runtimeEnvironmentSendValidation(args: {
  userDataPath: string
  environment: KnownRuntimeEnvironment
  method: string
  expectedPairingRevision?: number
  expectedRuntimeId?: string
  capabilityOutcome?: RuntimeEnvironmentCapabilityOutcome
}): RemoteRuntimeSendValidation {
  return () => {
    let environment: KnownRuntimeEnvironment
    try {
      environment = resolveEnvironment(args.userDataPath, args.environment.id)
    } catch {
      return runtimeEnvironmentChangedFailure(args.environment, args.method)
    }
    return (
      runtimeEnvironmentRevisionFailure(
        environment,
        args.expectedPairingRevision,
        args.method,
        args.expectedRuntimeId
      ) ??
      (args.capabilityOutcome &&
      !isRuntimeEnvironmentCapabilityOutcomeCurrent(args.capabilityOutcome)
        ? runtimeEnvironmentChangedFailure(environment, args.method)
        : null)
    )
  }
}
