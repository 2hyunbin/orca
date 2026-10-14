import type {
  SshRepoReadoption,
  SshTarget,
  SshTargetAddResult,
  SshTargetCreateInput,
  SshTargetUpdateInput
} from '../../shared/ssh-types'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { closeOrcadManagedTunnel } from './orcad-managed-tunnel'
import { rotateSshProviderAuthority } from './ssh-provider-authority'
import { getSshTargetRegistryStore, type SshTargetMutations } from './ssh-target-registry'
import {
  allowsDirectSshRelay,
  isManagedOrcadSshTarget,
  isRuntimeOwnedSshTarget
} from './ssh-connection-store'
import { connectionManager } from '../ipc/ssh-ipc-context'
import { runTargetLifecycle } from '../ipc/ssh-target-lifecycle-queue'
import { fingerprintRuntimeSshTarget } from './runtime-ssh-access'

// Why: add/import can re-adopt workspaces orphaned on a removed target id (see ssh-target-readoption); the renderer must refresh its repo list to surface them.
export function takeSshTargetRepoReadoptions(notifyReposChanged: () => void): SshRepoReadoption[] {
  const store = getSshTargetRegistryStore()
  if (!store || store.lastRepoReadoptions.length === 0) {
    return []
  }
  const repoReadoptions = store.lastRepoReadoptions
  store.lastRepoReadoptions = []
  for (const targetId of new Set(
    repoReadoptions.flatMap(({ oldTargetId, newTargetId }) => [oldTargetId, newTargetId])
  )) {
    rotateSshProviderAuthority(targetId)
  }
  // Why: paired clients refetch repos only on this event, and they may have made the change.
  notifyReposChanged()
  return repoReadoptions
}

// Why: generations, provisioning, the server fence and the runtime ladder cache are main-owned;
// a renderer must not forge them.
function omitRendererSshTargetGeneration<
  T extends {
    environmentProvider?: unknown
    generation?: unknown
    orcadProvisioning?: unknown
    orcadFence?: unknown
    managedServerUnavailable?: unknown
    managedServerMoveOffered?: unknown
    managedServerUpdateFailure?: unknown
    remoteRuntimeResolution?: unknown
  }
>(
  value: T
): Omit<
  T,
  | 'environmentProvider'
  | 'generation'
  | 'orcadProvisioning'
  | 'orcadFence'
  | 'managedServerUnavailable'
  | 'managedServerMoveOffered'
  | 'managedServerUpdateFailure'
  | 'remoteRuntimeResolution'
> {
  const {
    environmentProvider: _environmentProvider,
    generation: _generation,
    orcadProvisioning: _orcadProvisioning,
    orcadFence: _orcadFence,
    managedServerUnavailable: _managedServerUnavailable,
    managedServerMoveOffered: _managedServerMoveOffered,
    managedServerUpdateFailure: _managedServerUpdateFailure,
    remoteRuntimeResolution: _remoteRuntimeResolution,
    ...rest
  } = value
  return rest
}

function assertNotRuntimeOwned(targetId: string, action: string): void {
  const target = getSshTargetRegistryStore()!.getTarget(targetId)
  if (target && isRuntimeOwnedSshTarget(target)) {
    throw new Error(`Managed runtime SSH targets cannot be ${action} from SSH settings.`)
  }
}

/** Removing a managed host would strand its server; Stop proves the exit, Forget skips a dead host. */
export function assertNotManagedServerHost(targetId: string): void {
  const target = getSshTargetRegistryStore()!.getTarget(targetId)
  if (target && isManagedOrcadSshTarget(target)) {
    throw new Error(
      'This host runs a managed Orca server. Use Stop… under Settings › Managed servers to stop the server and remove it first, or Forget… there if the host is gone.'
    )
  }
}

function addSshTarget(
  input: SshTargetCreateInput,
  notifyReposChanged: () => void
): SshTargetAddResult {
  const target = getSshTargetRegistryStore()!.addTarget(omitRendererSshTargetGeneration(input))
  // Why: re-adding a removed host can re-adopt orphaned workspaces; refresh the renderer's repo list so they move back onto the live host.
  const repoReadoptions = takeSshTargetRepoReadoptions(notifyReposChanged)
  return { target, repoReadoptions }
}

function updateSshTarget(id: string, updates: SshTargetUpdateInput): SshTarget | null {
  assertNotRuntimeOwned(id, 'edited')
  const before = getSshTargetRegistryStore()!.getTarget(id)
  // The fence and generation are stripped, so a managed host keeps its server binding.
  const updated = getSshTargetRegistryStore()!.updateTarget(
    id,
    omitRendererSshTargetGeneration(updates)
  )
  const environmentId = getManagedOrcadFenceEnvironmentId(updated ?? undefined)
  if (environmentId && updated) {
    // Why: the tunnel and the SSH transport under it were built from the old fields, so both go
    // and the next use dials the edited target. Only a host reached through its managed server:
    // one an older build changed runs on the relay directly, whose session owns the transport.
    const redial =
      !allowsDirectSshRelay(updated) &&
      (!before || fingerprintRuntimeSshTarget(before) !== fingerprintRuntimeSshTarget(updated))
    void runTargetLifecycle(id, async () => {
      await closeOrcadManagedTunnel(environmentId)
      if (redial) {
        await connectionManager?.disconnect(id)
      }
    }).catch(() => undefined)
  }
  return updated
}

export function createSshTargetMutations(effects: {
  notifyReposChanged(): void
  removeTarget(targetId: string): Promise<void>
}): SshTargetMutations {
  return {
    add: (input) => addSshTarget(input, effects.notifyReposChanged),
    update: updateSshTarget,
    remove: async (id) => {
      assertNotRuntimeOwned(id, 'removed')
      assertNotManagedServerHost(id)
      await effects.removeTarget(id)
    }
  }
}
