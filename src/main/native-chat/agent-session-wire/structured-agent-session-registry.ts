import type { StructuredAgentSessionHost } from './structured-agent-session-host'

let host: StructuredAgentSessionHost | null = null
let held = false
let stopWatchingHost: (() => void) | null = null
const heldListeners = new Set<(held: boolean) => void>()

// Partial test hosts may omit holdsSessions.
function hostHoldsSessions(candidate: StructuredAgentSessionHost | null): boolean {
  return typeof candidate?.holdsSessions === 'function' && candidate.holdsSessions()
}

// Failed notification must not trigger host reinstallation and duplicate ownership.
function publishHeld(): void {
  try {
    const next = hostHoldsSessions(host)
    if (next === held) {
      return
    }
    held = next
    for (const listener of heldListeners) {
      try {
        listener(next)
      } catch (error) {
        console.warn('[structured-agent-session] a held-chats listener threw', error)
      }
    }
  } catch (error) {
    console.warn('[structured-agent-session] reading whether chats are held failed', error)
  }
}

export function setStructuredAgentSessionHost(next: StructuredAgentSessionHost | null): void {
  stopWatchingHost?.()
  stopWatchingHost = null
  host = next
  try {
    stopWatchingHost =
      typeof next?.onSessionsHeld === 'function' ? next.onSessionsHeld(publishHeld) : null
  } catch (error) {
    console.warn('[structured-agent-session] watching for held chats failed', error)
  }
  publishHeld()
  host?.advanceLegacyRest?.()
}

/** Includes saved/live chats; constructing a host holds none. */
export function structuredAgentSessionsHeld(): boolean {
  return hostHoldsSessions(host)
}

export function onStructuredAgentSessionsHeldChanged(
  listener: (held: boolean) => void
): () => void {
  heldListeners.add(listener)
  return () => heldListeners.delete(listener)
}

export function getStructuredAgentSessionHost(): StructuredAgentSessionHost | null {
  return host
}

let currentGraphReady: () => boolean = () => false
let foreground = 0

export function structuredJournalBackgroundReady(): boolean {
  return currentGraphReady() && foreground === 0
}

export function setStructuredJournalReadiness(read: () => boolean): void {
  currentGraphReady = read
  wakeStructuredJournalBackground()
}

export function wakeStructuredJournalBackground(): void {
  host?.advanceLegacyRest?.()
}

/** Observation only: actions never wait for background work. */
export function beginStructuredJournalForeground(signal?: AbortSignal): () => void {
  foreground++
  host?.advanceLegacyRest?.()
  let ended = false
  const finish = (): void => {
    if (ended) {
      return
    }
    ended = true
    foreground--
    signal?.removeEventListener('abort', finish)
    host?.advanceLegacyRest?.()
  }
  signal?.addEventListener('abort', finish, { once: true })
  if (signal?.aborted) {
    finish()
  }
  return finish
}
