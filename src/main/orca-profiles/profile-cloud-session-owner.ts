import { rmSync } from 'node:fs'
import type {
  OrcaCloudCapabilities,
  OrcaCloudOrgSummary,
  OrcaProfileCloudSummary,
  OrcaProfileListState
} from '../../shared/orca-profiles'
import { linkOrcaProfileToCloud } from './profile-cloud-index'
import type { OrcaCloudSessionExchangeResponse } from './profile-cloud-session-exchange'
import {
  clearOrcaCloudSession,
  getOrcaCloudSessionPath,
  readOrcaCloudSession,
  rememberOrcaCloudSessionInMemory,
  saveOrcaCloudSession,
  type OrcaCloudSession,
  type OrcaCloudSessionReadResult
} from './profile-cloud-session-store'

// The one owner of each profile's cloud session: every read and write of the session goes
// through here. Callers ask for changes; they never write a session they built themselves.

type SessionOwnerState = {
  // Bumped by sign-in and sign-out: a change begun before either may not land.
  generation: number
  // Bumped when the profile's cloud link moves: a server reply begun before it describes
  // the old link, so only its tokens may land.
  linkVersion: number
  // Signed out this run: the file is ignored even if it could not be removed.
  signedOut: boolean
}

export type CloudSessionTicket = { generation: number; linkVersion: number }

export type CloudSessionServerUpdate = {
  cloud?: OrcaProfileCloudSummary
  organizations?: OrcaCloudOrgSummary[]
  capabilities: OrcaCloudCapabilities
}

const owners = new Map<string, SessionOwnerState>()

function ownerOf(profileId: string, userDataPath: string): SessionOwnerState {
  const key = `${userDataPath}\0${profileId}`
  let owner = owners.get(key)
  if (!owner) {
    owner = { generation: 0, linkVersion: 0, signedOut: false }
    owners.set(key, owner)
  }
  return owner
}

function isCurrent(owner: SessionOwnerState, ticket: CloudSessionTicket): boolean {
  return !owner.signedOut && owner.generation === ticket.generation
}

function persist(
  profileId: string,
  userDataPath: string,
  session: OrcaCloudSession,
  rotated: boolean
): void {
  try {
    saveOrcaCloudSession(profileId, userDataPath, session)
  } catch {
    // Why: a rotated refresh token is already spent server-side. Losing the new one to a failed
    // write (disk full, locked file, keychain error) makes the next refresh replay the old token,
    // which the server reads as reuse and revokes the whole family.
    rememberOrcaCloudSessionInMemory(profileId, userDataPath, session)
    if (rotated) {
      // The file now holds the spent token; a restart replaying it would revoke the family.
      // Any other failed write leaves a still-valid file in place.
      try {
        rmSync(getOrcaCloudSessionPath(profileId, userDataPath), { force: true })
      } catch {
        // The in-memory session still wins for the rest of this run.
      }
    }
  }
}

function orgChanged(
  linked: OrcaProfileCloudSummary | undefined,
  next: OrcaProfileCloudSummary
): boolean {
  return (linked?.activeOrgId ?? '') !== (next.activeOrgId ?? '')
}

export function readCloudSession(
  profileId: string,
  userDataPath: string
): OrcaCloudSessionReadResult {
  if (ownerOf(profileId, userDataPath).signedOut) {
    return { status: 'missing', persistence: 'none' }
  }
  return readOrcaCloudSession(profileId, userDataPath)
}

// Take before a request whose reply will change the session.
export function cloudSessionTicket(profileId: string, userDataPath: string): CloudSessionTicket {
  const owner = ownerOf(profileId, userDataPath)
  return { generation: owner.generation, linkVersion: owner.linkVersion }
}

export function signInCloudSession(
  profileId: string,
  userDataPath: string,
  exchange: OrcaCloudSessionExchangeResponse
): void {
  const owner = ownerOf(profileId, userDataPath)
  owner.generation++
  owner.linkVersion++
  owner.signedOut = false
  persist(
    profileId,
    userDataPath,
    {
      accessToken: exchange.accessToken,
      refreshToken: exchange.refreshToken,
      expiresAt: exchange.expiresAt,
      organizations: exchange.organizations,
      capabilities: exchange.capabilities
    },
    false
  )
}

// Fences off every change in flight, e.g. before sign-out's network revoke.
export function invalidateCloudSessionChanges(profileId: string, userDataPath: string): void {
  const owner = ownerOf(profileId, userDataPath)
  owner.generation++
  owner.linkVersion++
}

export function signOutCloudSession(profileId: string, userDataPath: string): void {
  const owner = ownerOf(profileId, userDataPath)
  owner.generation++
  owner.linkVersion++
  owner.signedOut = true
  try {
    clearOrcaCloudSession(profileId, userDataPath)
  } catch {
    // `signedOut` already hides the file, so a revoked token is never read back.
  }
}

// Why: with rotation, only the session that actually failed may be cleared; a loser of a
// concurrent refresh race must not wipe the winner's rotated session. Returns whether it cleared.
export function signOutRevokedCloudSession(
  profileId: string,
  userDataPath: string,
  failed: OrcaCloudSession
): boolean {
  const current = readCloudSession(profileId, userDataPath)
  if (current.status === 'found' && current.session.refreshToken !== failed.refreshToken) {
    return false
  }
  // A session we were denied is not a session we may delete: the token we would be clearing
  // might not even be the one that failed.
  if (current.status === 'unreadable') {
    return false
  }
  signOutCloudSession(profileId, userDataPath)
  return true
}

/**
 * Lands a refresh reply. Why the tokens always land unless the session was signed out or
 * replaced: the token we sent is spent once the server rotates, and keeping it means the next
 * refresh replays it and the server revokes the family. Orgs, capabilities and the link follow
 * only when nothing relinked meanwhile; the link is best effort, after the tokens.
 */
export function commitCloudSessionRotation(
  profileId: string,
  userDataPath: string,
  ticket: CloudSessionTicket,
  linked: OrcaProfileCloudSummary | undefined,
  spent: OrcaCloudSession,
  rotated: OrcaCloudSessionExchangeResponse
): OrcaCloudSession | null {
  const owner = ownerOf(profileId, userDataPath)
  const current = readCloudSession(profileId, userDataPath)
  if (
    !isCurrent(owner, ticket) ||
    current.status !== 'found' ||
    current.session.refreshToken !== spent.refreshToken
  ) {
    return null
  }
  const tokens = {
    accessToken: rotated.accessToken,
    refreshToken: rotated.refreshToken,
    expiresAt: rotated.expiresAt
  }
  const relink = owner.linkVersion === ticket.linkVersion
  const next = relink
    ? { ...tokens, organizations: rotated.organizations, capabilities: rotated.capabilities }
    : { ...current.session, ...tokens }
  persist(profileId, userDataPath, next, true)
  if (relink) {
    try {
      linkOrcaProfileToCloud(profileId, rotated.cloud, userDataPath)
      if (orgChanged(linked, rotated.cloud)) {
        owner.linkVersion++
      }
    } catch {
      // The tokens are saved; the link is retried by the next refresh or org change.
    }
  }
  return next
}

// Org selection moves the link before its request, so a refresh already in flight lands
// only its tokens and cannot relink to the old org.
export function beginCloudSessionRelink(
  profileId: string,
  userDataPath: string
): CloudSessionTicket {
  ownerOf(profileId, userDataPath).linkVersion++
  return cloudSessionTicket(profileId, userDataPath)
}

/** Lands an org-selection or capability reply onto the current session; tokens are untouched. */
export function commitCloudSessionUpdate(
  profileId: string,
  userDataPath: string,
  ticket: CloudSessionTicket,
  linked: OrcaProfileCloudSummary | undefined,
  update: CloudSessionServerUpdate
): { list: OrcaProfileListState | null } | null {
  const owner = ownerOf(profileId, userDataPath)
  const current = readCloudSession(profileId, userDataPath)
  if (
    !isCurrent(owner, ticket) ||
    owner.linkVersion !== ticket.linkVersion ||
    current.status !== 'found'
  ) {
    return null
  }
  persist(
    profileId,
    userDataPath,
    {
      ...current.session,
      organizations: update.organizations ?? current.session.organizations,
      capabilities: update.capabilities
    },
    false
  )
  if (!update.cloud) {
    return { list: null }
  }
  const list = linkOrcaProfileToCloud(profileId, update.cloud, userDataPath)
  if (orgChanged(linked, update.cloud)) {
    owner.linkVersion++
  }
  return { list }
}
