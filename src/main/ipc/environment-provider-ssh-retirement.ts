import type { EnvironmentProviderSshLease } from '../ssh/environment-provider-ssh-admission'
import type { SshTarget } from '../../shared/ssh-types'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { closeOrcadManagedTunnel } from '../ssh/orcad-managed-tunnel'
import { clearSshHostServerStatus } from '../ssh/ssh-host-server-status'
import { invalidateConnectAttempt } from './ssh-connect-attempt-registry'
import { runTargetLifecycle } from './ssh-target-lifecycle-queue'
import { teardownSshTargetTransport } from '../ssh/ssh-target-transport'

function stillOwns(expected: SshTarget): boolean {
  const current = getSshTargetRegistryStore()?.getTarget(expected.id)
  return Boolean(
    current &&
    current.generation === expected.generation &&
    JSON.stringify(current.environmentProvider) === JSON.stringify(expected.environmentProvider)
  )
}

/** Retire contact without removing machine, workspace, target or managed-server ownership. */
export async function retireEnvironmentProviderSshTarget(input: SshTarget): Promise<void> {
  const expected = structuredClone(input)
  if (!expected.environmentProvider || !stillOwns(expected)) {
    return
  }
  invalidateConnectAttempt(expected.id)
  clearSshHostServerStatus(expected.id)
  await runTargetLifecycle(expected.id, async () => {
    if (!stillOwns(expected)) {
      return
    }
    const current = getSshTargetRegistryStore()?.getTarget(expected.id)
    const environmentId = getManagedOrcadFenceEnvironmentId(current ?? undefined)
    if (environmentId) {
      await closeOrcadManagedTunnel(environmentId)
    }
    if (stillOwns(expected)) {
      await teardownSshTargetTransport(expected.id)
    }
  })
}

export async function retireEnvironmentProviderConnections(
  providerId: string,
  resourceId?: string
): Promise<void> {
  const targets = getSshTargetRegistryStore()?.listTargets() ?? []
  const results = await Promise.allSettled(
    targets
      .filter(
        (target) =>
          target.environmentProvider?.binding?.providerId === providerId &&
          (resourceId === undefined || target.environmentProvider.resourceId === resourceId)
      )
      .map(retireEnvironmentProviderSshTarget)
  )
  const failures = results.filter((result) => result.status === 'rejected')
  if (failures.length) {
    throw new AggregateError(
      failures.map((result) => result.reason),
      'Provider SSH connections could not be retired'
    )
  }
}

const watched = new Map<string, { signal: AbortSignal; key: string; release(): void }>()
export function watchEnvironmentProviderSshLease(
  target: SshTarget,
  lease: EnvironmentProviderSshLease
): void {
  const expected = structuredClone(target)
  const key = JSON.stringify([expected.generation, expected.environmentProvider])
  const previous = watched.get(expected.id)
  if (previous?.signal === lease.signal && previous.key === key) {
    return
  }
  previous?.release()
  const entry = {
    signal: lease.signal,
    key,
    release: () => lease.signal.removeEventListener('abort', onAbort)
  }
  const onAbort = (): void => {
    entry.release()
    if (watched.get(expected.id) === entry) {
      watched.delete(expected.id)
    }
    void retireEnvironmentProviderSshTarget(expected).catch((error) =>
      console.warn('[plugins] failed to retire withdrawn SSH connection:', error)
    )
  }
  watched.set(expected.id, entry)
  lease.signal.addEventListener('abort', onAbort, { once: true })
  if (lease.signal.aborted) {
    onAbort()
  }
}
