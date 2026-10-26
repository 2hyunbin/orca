// The connected host's status stream, which every structured chat on that host reads the host's
// "Stopping…" from. One per client, opened by the first chat that reads it and kept for the
// client's life: a phone has no way to end just this stream, so one per chat would leave a host
// subscriber behind each. The client replays it after a reconnect, and the host's fresh snapshot
// then replaces what contact loss revoked.

import { worktreeIdentityKey } from '../../../src/shared/worktree/id'
import {
  foldAgentSessionStatusEvent,
  revokeAgentSessionStatusLive,
  type AgentSessionStatusSnapshot
} from '../../../src/shared/agent-session-status-snapshot-fold'
import type { AgentSessionStatusEvent } from '../../../src/shared/agent-session-wire'
import { isMobileMethodUnavailableError } from '../transport/mobile-method-unavailable'
import type { RpcClient } from '../transport/rpc-client'

export type MobileStructuredSessionStatusFeed = {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => AgentSessionStatusSnapshot
  isWorkspaceSetupHeld: (workspaceId: string) => boolean | undefined
}

const feeds = new WeakMap<RpcClient, MobileStructuredSessionStatusFeed>()

function isStatusEvent(value: unknown): value is AgentSessionStatusEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false
  }
  switch (value.type) {
    case 'snapshot':
      return 'sessions' in value && Array.isArray(value.sessions)
    case 'status':
      return 'session' in value && typeof value.session === 'object' && value.session !== null
    case 'end':
      return true
    default:
      return false
  }
}

/** The stream's refusal, as the client hands a failed opener to its listener. */
function streamRefusal(value: unknown): { code?: string; message?: string } | null {
  if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== 'error') {
    return null
  }
  const error = 'error' in value && typeof value.error === 'object' ? value.error : null
  const code = error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
  const message =
    'message' in value && typeof value.message === 'string' ? value.message : undefined
  return { ...(code !== undefined ? { code } : {}), ...(message !== undefined ? { message } : {}) }
}

function createFeed(client: RpcClient): MobileStructuredSessionStatusFeed {
  let snapshot: AgentSessionStatusSnapshot = new Map()
  let setupHeldWorkspaceIds: Set<string> | null = null
  // `unavailable`: the host refused the method to phones; asked again only on a new connection.
  let stream: 'closed' | 'open' | 'unavailable' = 'closed'
  // Released once the host ends the stream, so the client never replays it on a later session.
  let releaseStream = (): void => {}
  const release = (): void => {
    const pending = releaseStream
    releaseStream = () => {}
    pending()
  }
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) {
      listener()
    }
  }
  const setSnapshot = (next: AgentSessionStatusSnapshot): void => {
    if (next === snapshot) {
      return
    }
    snapshot = next
    notify()
  }
  const revokeLive = (): void => {
    setupHeldWorkspaceIds = null
    setSnapshot(revokeAgentSessionStatusLive(snapshot))
    notify()
  }
  const onFrame = (raw: unknown): void => {
    if (isStatusEvent(raw)) {
      if (raw.type === 'end') {
        release()
        stream = 'closed'
        revokeLive()
        return
      }
      if (
        raw.type === 'snapshot' &&
        (raw.setupHeldWorkspaceIds !== undefined || setupHeldWorkspaceIds === null)
      ) {
        setupHeldWorkspaceIds = new Set(raw.setupHeldWorkspaceIds?.map(worktreeIdentityKey))
      }
      if (
        raw.type === 'snapshot' &&
        raw.setupHeldWorkspaceIds !== undefined &&
        raw.sessions.length === 0
      ) {
        notify()
        return
      }
      setSnapshot(foldAgentSessionStatusEvent(snapshot, raw))
      return
    }
    const refusal = streamRefusal(raw)
    if (refusal) {
      release()
      // A host with the feed but from before phones could read it answers `forbidden`.
      stream = isMobileMethodUnavailableError(refusal.code, refusal.message)
        ? 'unavailable'
        : 'closed'
      revokeLive()
      if (stream === 'unavailable') {
        setupHeldWorkspaceIds = new Set()
        notify()
      }
    }
  }
  const open = (): void => {
    if (stream === 'closed' && listeners.size > 0) {
      stream = 'open'
      const dispose = client.subscribe('agentSession.subscribeStatus', {}, onFrame)
      // A stream that ended inside `subscribe` is released at once.
      if (stream === 'open') {
        releaseStream = dispose
      } else {
        dispose()
      }
    }
  }
  // Losing contact is never exit: only what a live host vouches for goes until it answers again.
  client.onStateChange((state) => {
    if (state === 'connected') {
      open()
      return
    }
    // The next connection may reach an updated host, so a refusal holds for one connection only.
    if (stream === 'unavailable') {
      stream = 'closed'
    }
    revokeLive()
  })
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      open()
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => snapshot,
    isWorkspaceSetupHeld: (workspaceId) =>
      setupHeldWorkspaceIds?.has(worktreeIdentityKey(workspaceId))
  }
}

export function mobileStructuredSessionStatusFeed(
  client: RpcClient
): MobileStructuredSessionStatusFeed {
  let feed = feeds.get(client)
  if (!feed) {
    feed = createFeed(client)
    feeds.set(client, feed)
  }
  return feed
}
