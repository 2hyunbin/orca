import type { SshConnectionStore } from '../ssh/ssh-connection-store'
import type { SshTarget } from '../../shared/ssh-types'
import type { PluginEnvironmentSshBinding } from '../../shared/plugins/plugin-environment-ssh-binding'
import type { EnvironmentRecipeJournalBinding } from '../../shared/plugins/plugin-environment-recipe-journal'

export function environmentProviderSshFields(
  owner: PluginEnvironmentSshBinding,
  label: string,
  identityFile?: string
) {
  const connection = owner.connection
  return {
    label,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    ...(connection.configHost ? { configHost: connection.configHost } : {}),
    ...(identityFile ? { identityFile } : {})
  }
}

export async function publishEnvironmentProviderSshTarget(
  store: SshConnectionStore,
  owner: PluginEnvironmentSshBinding,
  label: string,
  identityFile?: string,
  previousOwner?: EnvironmentRecipeJournalBinding,
  reviewedPrevious?: SshTarget
): Promise<SshTarget> {
  const target = store.upsertEnvironmentProviderTarget(
    owner,
    environmentProviderSshFields(owner, label, identityFile),
    previousOwner,
    reviewedPrevious
  )
  await store.getOrcadMigrationSource().flushPendingOrThrowAsync()
  return target
}
