import type { KnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { getRuntimeSshAccess } from '../../../shared/runtime-environments'
import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import type { SshTarget } from '../../../shared/ssh-types'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import type { OrcadTunnelStartChecks } from './orcad-managed-tunnel-target'
import { ensureSshConnectionManager } from '../../ssh/targets/ssh-target-registry'
import { supersededTunnelError } from './orcad-managed-tunnel-active'
import { createSshSubsystemLoader } from '../../ipc/ssh/ssh-subsystem-loader'
import type * as ManagedTunnelImplementation from './orcad-managed-tunnel-implementation'

const subsystem = createSshSubsystemLoader(
  () => import('./orcad-managed-tunnel-implementation'),
  (implementation) => {
    implementation.initializeManagedOrcadTunnels()
    return implementation
  }
)

type PendingTunnelStart = { environmentId: string; targetId?: string; cancelled: boolean }
const pendingStarts = new Set<PendingTunnelStart>()

async function startTunnelRequest<Result>(
  environmentId: string,
  targetId: string | undefined,
  prepare: (() => Promise<void>) | undefined,
  start: (implementation: typeof ManagedTunnelImplementation) => Promise<Result>
): Promise<Result> {
  const request = { environmentId, targetId, cancelled: false }
  pendingStarts.add(request)
  try {
    await prepare?.()
    if (request.cancelled) {
      throw supersededTunnelError()
    }
    const implementation = await subsystem.load()
    if (request.cancelled) {
      throw supersededTunnelError()
    }
    return start(implementation)
  } finally {
    pendingStarts.delete(request)
  }
}

export async function ensureOrcadManagedTunnel(
  userDataPath: string,
  selector: string
): Promise<KnownRuntimeEnvironment> {
  const environment = resolveEnvironment(userDataPath, selector)
  if (!getRuntimeSshAccess(environment)) {
    return environment
  }
  return startTunnelRequest(
    environment.id,
    getRuntimeSshAccess(environment)?.sshTargetId,
    ensureSshConnectionManager,
    (implementation) => implementation.ensureOrcadManagedTunnel(userDataPath, selector)
  )
}

export async function rebuildOrcadManagedTunnel(
  userDataPath: string,
  selector: string
): Promise<'built' | 'repaired'> {
  const environment = resolveEnvironment(userDataPath, selector)
  if (!getRuntimeSshAccess(environment)) {
    return 'built'
  }
  return startTunnelRequest(
    environment.id,
    getRuntimeSshAccess(environment)?.sshTargetId,
    ensureSshConnectionManager,
    (implementation) => implementation.rebuildOrcadManagedTunnel(userDataPath, selector)
  )
}

export function recoverRefusedManagedOrcadPairing(userDataPath: string, environmentId: string) {
  return rebuildOrcadManagedTunnel(userDataPath, environmentId)
}

export function managedOrcadPairingFailureStands(
  userDataPath: string,
  environmentId: string
): boolean {
  return subsystem.loaded?.managedOrcadPairingFailureStands(userDataPath, environmentId) ?? false
}

export function forgetFailedManagedOrcadPairingRepair(
  userDataPath: string,
  environmentId: string
): void {
  subsystem.loaded?.forgetFailedManagedOrcadPairingRepair(userDataPath, environmentId)
}

export async function verifyManagedTunnelServing(environment: KnownRuntimeEnvironment) {
  return startTunnelRequest(
    environment.id,
    getRuntimeSshAccess(environment)?.sshTargetId,
    ensureSshConnectionManager,
    (implementation) => implementation.verifyManagedTunnelServing(environment)
  )
}

export function disposeOrcadManagedTunnels(): void {
  for (const request of pendingStarts) {
    request.cancelled = true
  }
  subsystem.loaded?.disposeOrcadManagedTunnels()
}

export function shutdownOrcadManagedTunnels(): Promise<void> {
  for (const request of pendingStarts) {
    request.cancelled = true
  }
  return subsystem.loaded?.shutdownOrcadManagedTunnels() ?? Promise.resolve()
}

export function recoverOrcadManagedTunnelsAfterHostResume(
  userDataPath: string,
  options: { attempts: number; timeoutMs: number }
): Promise<void> {
  return (
    subsystem.loaded?.recoverOrcadManagedTunnelsAfterHostResume(userDataPath, options) ??
    Promise.resolve()
  )
}

export async function startOrcadManagedTunnel(
  environmentId: string,
  target: SshTarget,
  connection: SshConnection,
  remotePort: number,
  checks?: OrcadTunnelStartChecks
): Promise<number> {
  return startTunnelRequest(environmentId, target.id, undefined, (implementation) =>
    implementation.startOrcadManagedTunnel(environmentId, target, connection, remotePort, checks)
  )
}

export function closeOrcadManagedTunnel(environmentId: string): Promise<void> {
  for (const request of pendingStarts) {
    if (request.environmentId === environmentId) {
      request.cancelled = true
    }
  }
  return subsystem.loaded?.closeOrcadManagedTunnel(environmentId) ?? Promise.resolve()
}

export function closeOrcadManagedTunnelsForTarget(targetId: string): Promise<void> {
  for (const request of pendingStarts) {
    if (request.targetId === targetId) {
      request.cancelled = true
    }
  }
  return subsystem.loaded?.closeOrcadManagedTunnelsForTarget(targetId) ?? Promise.resolve()
}
