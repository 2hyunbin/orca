import type { RefreshCurrentOrcaProfileAuthResult } from '../../shared/orca-profiles'
import { getOrcaCloudAuthConfig, isOrcaCloudDevAuthEnabled } from './profile-cloud-auth-config'
import { getOrcaProfileAuthStatusFromProfile } from './profile-cloud-auth-status'
import { refreshOrcaCloudCapabilities } from './profile-cloud-client'
import { linkOrcaProfileToCloud } from './profile-cloud-index'
import { ensureActiveOrcaProfile, getOrcaProfileListState } from './profile-index-store'
import { refreshDevOrcaCloudProfile } from './profile-cloud-dev-service'
import {
  captureCloudSessionMutation,
  cloudSessionIdentity,
  recordCloudSessionIdentityMutationIfCurrent
} from './profile-cloud-session-mutation'
import { runWithFreshOrcaCloudSession } from './profile-cloud-session-refresh'
import { updateStoredOrcaCloudSession } from './profile-cloud-session-store'

export async function refreshCurrentOrcaProfileAuth(
  userDataPath: string
): Promise<RefreshCurrentOrcaProfileAuthResult> {
  const active = ensureActiveOrcaProfile(userDataPath)
  const auth = () => getOrcaProfileAuthStatusFromProfile(active, userDataPath)
  if (!active.profile.cloud) {
    return { status: 'local', auth: auth() }
  }
  if (isOrcaCloudDevAuthEnabled()) {
    const result = refreshDevOrcaCloudProfile(active, userDataPath)
    if (result.status !== 'updated') {
      return { status: 'reconnect-required', auth: auth() }
    }
    return {
      status: 'refreshed',
      auth: auth(),
      activeProfileId: result.list.activeProfileId,
      profiles: result.list.profiles
    }
  }
  const configState = getOrcaCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured', auth: auth() }
  }
  try {
    let identity = cloudSessionIdentity(active.profile.id, active.profile.cloud)
    let mutationSnapshot = captureCloudSessionMutation(identity, userDataPath)
    const operation = await runWithFreshOrcaCloudSession(
      configState.config,
      active,
      userDataPath,
      (session) => {
        // Why: fence at request time, after any refresh; that refresh may relink the org.
        const linked = ensureActiveOrcaProfile(userDataPath).profile.cloud
        if (linked) {
          identity = cloudSessionIdentity(active.profile.id, linked)
          mutationSnapshot = captureCloudSessionMutation(identity, userDataPath)
        }
        return refreshOrcaCloudCapabilities(configState.config, session)
      }
    )
    if (operation.status !== 'ok') {
      return { status: 'reconnect-required', auth: auth() }
    }
    const refresh = operation.value
    if (refresh.cloud) {
      const refreshedIdentity = cloudSessionIdentity(active.profile.id, refresh.cloud)
      if (
        refreshedIdentity.cloudUserId !== identity.cloudUserId ||
        refreshedIdentity.cloudProfileId !== identity.cloudProfileId
      ) {
        throw new Error('orca_cloud_identity_changed_during_capability_refresh')
      }
      if (refreshedIdentity.organizationId !== identity.organizationId) {
        const advanced = recordCloudSessionIdentityMutationIfCurrent(
          refreshedIdentity,
          userDataPath,
          mutationSnapshot
        )
        if (!advanced) {
          return { status: 'reconnect-required', auth: auth() }
        }
        mutationSnapshot = advanced
      }
    }
    const saved = updateStoredOrcaCloudSession(
      active.profile.id,
      userDataPath,
      mutationSnapshot,
      (current) => ({
        ...current,
        organizations: refresh.organizations ?? current.organizations,
        capabilities: refresh.capabilities
      })
    )
    if (!saved) {
      return { status: 'reconnect-required', auth: auth() }
    }
    const list = refresh.cloud
      ? linkOrcaProfileToCloud(active.profile.id, refresh.cloud, userDataPath)
      : getOrcaProfileListState(userDataPath)
    return {
      status: 'refreshed',
      auth: getOrcaProfileAuthStatusFromProfile(
        ensureActiveOrcaProfile(userDataPath),
        userDataPath
      ),
      activeProfileId: list.activeProfileId,
      profiles: list.profiles
    }
  } catch (error) {
    return {
      status: 'failed',
      auth: auth(),
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
