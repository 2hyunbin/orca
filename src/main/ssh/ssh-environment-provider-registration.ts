import { createHash } from 'node:crypto'
import type { Store } from '../persistence'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import type { SshTarget } from '../../shared/ssh-types'
import type { EnvironmentRecipeJournalBinding } from '../../shared/plugins/plugin-environment-recipe-journal'
import {
  environmentProviderSshOwnerMatches,
  pluginEnvironmentSshBindingSchema,
  type PluginEnvironmentSshBinding
} from '../../shared/plugins/plugin-environment-ssh-binding'

export function environmentProviderSshTargetId(owner: {
  binding: Pick<EnvironmentRecipeJournalBinding, 'providerId' | 'contextId'>
  resourceId: string
}): string {
  const key = createHash('sha256')
    .update(JSON.stringify([owner.binding.providerId, owner.binding.contextId, owner.resourceId]))
    .digest('hex')
  return `provider-ssh-${key}`
}

export function assertEnvironmentProviderSshOwner(
  existing: SshTarget | undefined,
  owner: PluginEnvironmentSshBinding,
  migratedFrom?: EnvironmentRecipeJournalBinding
): void {
  if (
    existing &&
    (!existing.environmentProvider ||
      existing.owner ||
      (!environmentProviderSshOwnerMatches(existing.environmentProvider, owner) &&
        !(
          migratedFrom &&
          JSON.stringify(existing.environmentProvider.binding) === JSON.stringify(migratedFrom) &&
          migratedFrom.providerId === owner.binding.providerId &&
          migratedFrom.contextId === owner.binding.contextId &&
          migratedFrom.executionHostId === owner.binding.executionHostId &&
          existing.environmentProvider.resourceId === owner.resourceId
        )))
  ) {
    throw new Error('The saved SSH connection belongs to another environment owner')
  }
}

export function upsertEnvironmentProviderTarget(
  store: Store,
  input: PluginEnvironmentSshBinding,
  target: Pick<SshTarget, 'label' | 'host' | 'port' | 'username' | 'configHost' | 'identityFile'>,
  migratedFrom?: EnvironmentRecipeJournalBinding,
  reviewedPrevious?: SshTarget
): SshTarget {
  const next = prepareEnvironmentProviderTarget(
    store,
    input,
    target,
    migratedFrom,
    reviewedPrevious
  )
  if (store.getSshTarget(next.id)) {
    return store.updateSshTarget(next.id, next) ?? next
  }
  store.addSshTarget(next)
  return next
}

export function prepareEnvironmentProviderTarget(
  store: Store,
  input: PluginEnvironmentSshBinding,
  target: Pick<SshTarget, 'label' | 'host' | 'port' | 'username' | 'configHost' | 'identityFile'>,
  migratedFrom?: EnvironmentRecipeJournalBinding,
  reviewedPrevious?: SshTarget,
  completedManaged?: { environmentId: string; generation: number }
): SshTarget {
  const owner = pluginEnvironmentSshBindingSchema.parse(structuredClone(input))
  if (
    owner.binding.executionHostId !== 'local' ||
    target.host !== owner.connection.host ||
    target.port !== owner.connection.port ||
    target.username !== owner.connection.username ||
    (target.configHost ?? target.host) !== (owner.connection.configHost ?? owner.connection.host)
  ) {
    throw new Error('SSH endpoint differs from its execution host or reviewed provider connection')
  }
  const id = environmentProviderSshTargetId(owner)
  const existing = store.getSshTarget(id)
  assertEnvironmentProviderSshOwner(existing, owner, migratedFrom)
  if (reviewedPrevious && JSON.stringify(existing) !== JSON.stringify(reviewedPrevious)) {
    throw new Error('The saved SSH target changed after its endpoint was reviewed')
  }
  const changedConnection = Boolean(
    existing?.environmentProvider &&
    JSON.stringify(existing.environmentProvider.connection) !== JSON.stringify(owner.connection)
  )
  if (changedConnection && !reviewedPrevious) {
    throw new Error('Provider connection details changed; the saved host requires migration')
  }
  const completed =
    completedManaged &&
    existing?.generation === completedManaged.generation &&
    getManagedOrcadFenceEnvironmentId(existing) === completedManaged.environmentId
  if (changedConnection && existing?.orcadProvisioning && !completed) {
    throw new Error('The saved SSH host is still provisioning its managed server')
  }
  const next: SshTarget = {
    ...existing,
    label: target.label,
    host: target.host,
    port: target.port,
    username: target.username,
    ...(target.identityFile ? { identityFile: target.identityFile } : {}),
    allowRemoteCliControl: existing?.allowRemoteCliControl ?? false,
    id,
    environmentProvider: owner,
    source: 'manual',
    configHost: target.configHost ?? target.host,
    generation: changedConnection
      ? store.allocateSshTargetGeneration()
      : (existing?.generation ?? store.allocateSshTargetGeneration()),
    ...(changedConnection
      ? {
          remoteRuntimeResolution: undefined,
          managedServerUnavailable: undefined,
          managedServerMoveOffered: undefined,
          managedServerUpdateFailure: undefined
        }
      : {})
  }
  return next
}
