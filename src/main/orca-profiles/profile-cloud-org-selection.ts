import type { OrcaCloudAuthConfig } from './profile-cloud-auth-config'
import { OrcaCloudRequestError, selectOrcaCloudOrg } from './profile-cloud-client'
import { forceRefreshOrcaCloudSession } from './profile-cloud-session-refresh'
import { linkOrcaProfileToCloud } from './profile-cloud-index'
import type { ActiveOrcaProfileState } from './profile-index-store'
import {
  cloudSessionIdentity,
  recordCloudSessionIdentityMutation,
  recordCloudSessionIdentityMutationIfCurrent
} from './profile-cloud-session-mutation'
import {
  readOrcaCloudSession,
  updateStoredOrcaCloudSession,
  type OrcaCloudSession
} from './profile-cloud-session-store'

export async function selectCloudOrgWithMutationFence(input: {
  config: OrcaCloudAuthConfig
  active: ActiveOrcaProfileState
  userDataPath: string
  orgId: string
}): Promise<ReturnType<typeof linkOrcaProfileToCloud> | null> {
  const cloud = input.active.profile.cloud
  const stored = readOrcaCloudSession(input.active.profile.id, input.userDataPath)
  if (!cloud || stored.status !== 'found') {
    return null
  }
  const oldIdentity = cloudSessionIdentity(input.active.profile.id, cloud)
  const targetIdentity = {
    ...oldIdentity,
    organizationId: input.orgId
  }
  // Why: advance the durable identity fence before the first request. An old
  // refresh may finish, but its compare-and-save can no longer publish.
  const snapshot = recordCloudSessionIdentityMutation(targetIdentity, input.userDataPath)
  let workingSession: OrcaCloudSession = stored.session
  try {
    let selected
    try {
      selected = await selectOrcaCloudOrg(input.config, workingSession, input.orgId)
    } catch (error) {
      if (!(error instanceof OrcaCloudRequestError) || error.statusCode !== 401) {
        throw error
      }
      // Why: the shared single-flight refresh saves the rotation; a private one raced it.
      const refreshed = await forceRefreshOrcaCloudSession(
        input.config,
        input.active,
        input.userDataPath,
        workingSession
      )
      if (refreshed.status !== 'found') {
        throw error
      }
      workingSession = refreshed.session
      selected = await selectOrcaCloudOrg(input.config, workingSession, input.orgId)
    }
    if (
      selected.cloud.userId !== cloud.userId ||
      selected.cloud.cloudProfileId !== cloud.cloudProfileId ||
      selected.cloud.activeOrgId !== input.orgId
    ) {
      throw new Error('orca_cloud_org_selection_identity_mismatch')
    }
    // Why: merge onto the latest stored session; a refresh may have rotated the tokens
    // meanwhile, and writing back the ones this started with would store a spent token.
    const saved = updateStoredOrcaCloudSession(
      input.active.profile.id,
      input.userDataPath,
      snapshot,
      (latest) => ({
        ...latest,
        organizations: selected.organizations ?? latest.organizations,
        capabilities: selected.capabilities
      })
    )
    if (!saved) {
      throw new Error('stale_cloud_session_mutation')
    }
    const list = linkOrcaProfileToCloud(input.active.profile.id, selected.cloud, input.userDataPath)
    return list
  } catch (error) {
    recordCloudSessionIdentityMutationIfCurrent(oldIdentity, input.userDataPath, snapshot)
    throw error
  }
}
