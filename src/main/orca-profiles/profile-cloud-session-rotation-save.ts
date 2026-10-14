import { linkOrcaProfileToCloud } from './profile-cloud-index'
import type { OrcaCloudSessionExchangeResponse } from './profile-cloud-session-exchange'
import {
  cloudSessionIdentity,
  cloudSessionIdentityKey,
  readLiveCloudSessionMutation,
  recordCloudSessionIdentityMutationIfCurrent,
  type CloudSessionMutationSnapshot
} from './profile-cloud-session-mutation'
import {
  type OrcaCloudSession,
  readOrcaCloudSession,
  saveOrcaCloudSessionIfCurrent
} from './profile-cloud-session-store'

export class StaleCloudSessionMutationError extends Error {
  constructor() {
    super('stale_cloud_session_mutation')
  }
}

export // Why: once the server rotates, the token we sent is spent; keeping it means the next refresh
// replays it and the server revokes the whole family. So the save is a compare-and-swap on the
// spent token, refused only by a sign-out. Identity linkage moves only under our own fence.
function saveRotatedCloudSession(
  profileId: string,
  userDataPath: string,
  spent: OrcaCloudSession,
  rotated: OrcaCloudSessionExchangeResponse,
  snapshot: CloudSessionMutationSnapshot
): OrcaCloudSession {
  let live = readLiveCloudSessionMutation(profileId, userDataPath)
  const current = readOrcaCloudSession(profileId, userDataPath)
  if (!live || current.status !== 'found' || current.session.refreshToken !== spent.refreshToken) {
    throw new StaleCloudSessionMutationError()
  }
  const tokens = {
    accessToken: rotated.accessToken,
    refreshToken: rotated.refreshToken,
    expiresAt: rotated.expiresAt
  }
  const ownsFence = live.epoch === snapshot.epoch && live.identityKey === snapshot.identityKey
  if (ownsFence) {
    const rotatedIdentity = cloudSessionIdentity(profileId, rotated.cloud)
    if (cloudSessionIdentityKey(rotatedIdentity) !== live.identityKey) {
      console.warn('[orca-cloud] refresh reported a different active org; relinking to it')
      live = recordCloudSessionIdentityMutationIfCurrent(rotatedIdentity, userDataPath, live)
    }
  }
  const next: OrcaCloudSession =
    ownsFence && live
      ? { ...tokens, organizations: rotated.organizations, capabilities: rotated.capabilities }
      : { ...current.session, ...tokens }
  if (!live || saveOrcaCloudSessionIfCurrent(profileId, userDataPath, next, live) === null) {
    throw new StaleCloudSessionMutationError()
  }
  if (ownsFence) {
    linkOrcaProfileToCloud(profileId, rotated.cloud, userDataPath)
  }
  return next
}
