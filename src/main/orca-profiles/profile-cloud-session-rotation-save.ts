import { linkOrcaProfileToCloud } from './profile-cloud-index'
import type { OrcaCloudSessionExchangeResponse } from './profile-cloud-session-exchange'
import {
  cloudSessionIdentity,
  cloudSessionIdentityKey,
  readLiveCloudSessionMutation,
  recordCloudSessionIdentityMutationIfCurrent,
  type CloudSessionIdentity,
  type CloudSessionMutationSnapshot
} from './profile-cloud-session-mutation'
import { type OrcaCloudSession, updateStoredOrcaCloudSession } from './profile-cloud-session-store'

export class StaleCloudSessionMutationError extends Error {
  constructor() {
    super('stale_cloud_session_mutation')
  }
}

// Why: once the server rotates, the token we sent is spent; keeping it means the next refresh
// replays it and the server revokes the whole family. So the tokens are saved first, as a
// compare-and-swap on the spent token refused only by a sign-out; linkage follows, best effort.
export function saveRotatedCloudSession(
  profileId: string,
  userDataPath: string,
  spent: OrcaCloudSession,
  rotated: OrcaCloudSessionExchangeResponse,
  snapshot: CloudSessionMutationSnapshot,
  linkedIdentity: CloudSessionIdentity
): OrcaCloudSession {
  const live = readLiveCloudSessionMutation(profileId, userDataPath)
  if (!live) {
    throw new StaleCloudSessionMutationError()
  }
  const rotatedIdentity = cloudSessionIdentity(profileId, rotated.cloud)
  const ownsFence = live.epoch === snapshot.epoch && live.identityKey === snapshot.identityKey
  const sameIdentity = cloudSessionIdentityKey(rotatedIdentity) === live.identityKey
  const tokens = {
    accessToken: rotated.accessToken,
    refreshToken: rotated.refreshToken,
    expiresAt: rotated.expiresAt
  }
  const saved = updateStoredOrcaCloudSession(
    profileId,
    userDataPath,
    live,
    (current) => {
      if (current.refreshToken !== spent.refreshToken) {
        return null
      }
      // Server orgs/capabilities describe the identity it reported; keep them only when ours.
      return ownsFence && sameIdentity
        ? { ...tokens, organizations: rotated.organizations, capabilities: rotated.capabilities }
        : { ...current, ...tokens }
    },
    { rotatesRefreshToken: true }
  )
  if (!saved) {
    throw new StaleCloudSessionMutationError()
  }
  if (ownsFence) {
    relinkAfterRotation(
      profileId,
      userDataPath,
      rotated,
      live,
      sameIdentity ? null : linkedIdentity
    )
  }
  return saved
}

function relinkAfterRotation(
  profileId: string,
  userDataPath: string,
  rotated: OrcaCloudSessionExchangeResponse,
  live: CloudSessionMutationSnapshot,
  linked: CloudSessionIdentity | null
): void {
  let advanced: CloudSessionMutationSnapshot | null = null
  try {
    if (linked) {
      console.warn('[orca-cloud] refresh reported a different active org; relinking to it')
      const rotatedIdentity = cloudSessionIdentity(profileId, rotated.cloud)
      advanced = recordCloudSessionIdentityMutationIfCurrent(rotatedIdentity, userDataPath, live)
      if (!advanced) {
        return
      }
    }
    linkOrcaProfileToCloud(profileId, rotated.cloud, userDataPath)
  } catch (error) {
    // Why: a fence left on the new org while the link keeps the old one would fail every
    // later capability refresh; roll it back so fence and link agree again.
    if (linked && advanced) {
      try {
        recordCloudSessionIdentityMutationIfCurrent(linked, userDataPath, advanced)
      } catch {
        // The tokens are saved either way; only the link stays stale.
      }
    }
    console.warn(
      '[orca-cloud] could not update the profile link after a refresh:',
      error instanceof Error ? error.message : String(error)
    )
  }
}
