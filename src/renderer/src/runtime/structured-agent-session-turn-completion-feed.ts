// Share host completion/prompt edges per target without snapshots, buffers or reconnect catch-up. Status feed retains state; this feed intentionally loses outage edges. Retention would create unread obligations with nothing to retire them and relight already-read work.

import type { AgentSessionTurnCompletionEvent } from '../../../shared/agent-session-wire'
import type { AgentSessionAttentionEdge } from '../../../shared/agent-session-attention'
import {
  AGENT_SESSION_TURN_COMPLETION_RUNTIME_CAPABILITY,
  AGENT_SESSION_PHONE_RELAY_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import {
  onRuntimeEnvironmentsRetired,
  onRuntimeEnvironmentRevisionsChanged
} from './runtime-environment-revision'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { subscribeStructuredAgentSessionTurnCompletions } from './structured-agent-session-client'

export type StructuredAgentSessionTurnCompletionListener = (edge: AgentSessionAttentionEdge) => void

export type StructuredAgentSessionTurnCompletionFeedOwner = {
  activate: () => () => void
  subscribe: (listener: StructuredAgentSessionTurnCompletionListener) => () => void
}

const RECONNECT_MAX_DELAY_MS = 5_000

/** `stop` is the map's own teardown, not part of the owner contract callers hold. */
type OwnedTurnCompletionFeed = StructuredAgentSessionTurnCompletionFeedOwner & { stop: () => void }

const owners = new Map<string, OwnedTurnCompletionFeed>()

export function structuredAgentSessionTurnCompletionFeedKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

function createOwner(
  target: RuntimeClientTarget,
  phoneRelaySessionId: string | undefined,
  evict: () => void,
  retain: () => OwnedTurnCompletionFeed
): OwnedTurnCompletionFeed {
  const listeners = new Set<StructuredAgentSessionTurnCompletionListener>()
  const activations = new Set<symbol>()
  let stopRevisionListeners = (): void => {}
  let setup: AbortController | null = null
  let generation = 0
  let handle: { unsubscribe: () => void } | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0

  const deliver = (edge: AgentSessionAttentionEdge): void => {
    // A copy, so a listener that unsubscribes mid-fanout does not skip its neighbour.
    for (const listener of Array.from(listeners)) {
      try {
        listener(edge)
      } catch (error) {
        console.warn('[structured-session-completion] listener failed', error)
      }
    }
  }
  const active = (candidate: number): boolean => activations.size > 0 && candidate === generation
  const clearReconnect = (): void => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }
  const dropHandle = (): void => {
    setup?.abort()
    setup = null
    handle?.unsubscribe()
    handle = null
  }
  let open = (): void => {}
  const scheduleReconnect = (candidate: number): void => {
    if (!active(candidate) || reconnectTimer) {
      return
    }
    const delay = Math.min(250 * 2 ** reconnectAttempt, RECONNECT_MAX_DELAY_MS)
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (active(candidate)) {
        open()
      }
    }, delay)
  }
  // Reconnect starts empty; host retains no missed-edge history to request.
  const loseConnection = (candidate: number): void => {
    if (candidate !== generation) {
      return
    }
    generation += 1
    dropHandle()
    scheduleReconnect(generation)
  }
  const subscribeToHost = (candidate: number): void => {
    setup = target.kind === 'environment' ? new AbortController() : null
    const callbacks = [
      (event: AgentSessionTurnCompletionEvent) => {
        if (!active(candidate)) {
          return
        }
        if (event.type === 'end') {
          loseConnection(candidate)
          return
        }
        reconnectAttempt = 0
        // An arm this build cannot name is dropped, not handed on half-read.
        if (event.type === 'completion' || event.type === 'prompt') {
          deliver(event)
        }
      },
      () => {
        if (active(candidate)) {
          loseConnection(candidate)
        }
      },
      () => {
        if (active(candidate)) {
          loseConnection(candidate)
        }
      }
    ] as const
    const opening = setup
      ? subscribeStructuredAgentSessionTurnCompletions(
          target,
          ...callbacks,
          phoneRelaySessionId,
          setup.signal
        )
      : subscribeStructuredAgentSessionTurnCompletions(target, ...callbacks)
    void opening
      .then((opened) => {
        if (active(candidate)) {
          handle = opened
        } else {
          opened.unsubscribe()
        }
      })
      .catch(() => loseConnection(candidate))
  }
  open = (): void => {
    const candidate = ++generation
    dropHandle()
    if (target.kind !== 'environment') {
      // A local host is this build; only a remote one can predate the method.
      subscribeToHost(candidate)
      return
    }
    const environmentId = target.environmentId
    void runtimeEnvironmentSupportsCapability(
      environmentId,
      AGENT_SESSION_TURN_COMPLETION_RUNTIME_CAPABILITY
    )
      .then(async (supported) => {
        if (!active(candidate)) {
          return
        }
        // Unsupported methods stop permanently; failed probes remain retryable to avoid endless relay probing.
        if (supported) {
          if (
            phoneRelaySessionId &&
            !(await runtimeEnvironmentSupportsCapability(
              environmentId,
              AGENT_SESSION_PHONE_RELAY_RUNTIME_CAPABILITY
            ))
          ) {
            if (active(candidate)) {
              const fallback = getStructuredAgentSessionTurnCompletionFeed(target)
              const stopListening = fallback.subscribe(deliver)
              const release = fallback.activate()
              handle = {
                unsubscribe: () => {
                  release()
                  stopListening()
                }
              }
            }
            return
          }
          if (active(candidate)) {
            subscribeToHost(candidate)
          }
          return
        }
        console.warn(
          '[structured-session-completion] host too old for the turn-completion feed',
          environmentId
        )
      })
      .catch(() => loseConnection(candidate))
  }
  const stop = (): void => {
    generation += 1
    clearReconnect()
    dropHandle()
    stopRevisionListeners()
    stopRevisionListeners = () => {}
    reconnectAttempt = 0
  }
  const evictIdle = (): void => {
    if (activations.size === 0 && listeners.size === 0) {
      evict()
    }
  }

  const owner: OwnedTurnCompletionFeed = {
    activate: () => {
      const current = retain()
      if (current !== owner) {
        return current.activate()
      }
      const token = Symbol('turn-completion-feed')
      activations.add(token)
      if (activations.size === 1) {
        if (target.kind === 'environment') {
          const changed = (ids: readonly string[]): void => {
            if (ids.includes(target.environmentId)) {
              loseConnection(generation)
            }
          }
          const stopRetired = onRuntimeEnvironmentsRetired(changed)
          const stopChanged = onRuntimeEnvironmentRevisionsChanged(changed)
          stopRevisionListeners = () => {
            stopRetired()
            stopChanged()
          }
        }
        open()
      }
      return () => {
        activations.delete(token)
        if (activations.size === 0) {
          stop()
          evictIdle()
        }
      }
    },
    subscribe: (listener) => {
      const current = retain()
      if (current !== owner) {
        return current.subscribe(listener)
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        evictIdle()
      }
    },
    stop
  }
  return owner
}

export function getStructuredAgentSessionTurnCompletionFeed(
  target: RuntimeClientTarget,
  phoneRelaySessionId?: string
): StructuredAgentSessionTurnCompletionFeedOwner {
  const key = JSON.stringify([
    structuredAgentSessionTurnCompletionFeedKey(target),
    phoneRelaySessionId
  ])
  let owner = owners.get(key)
  if (!owner) {
    const created = createOwner(
      target,
      phoneRelaySessionId,
      () => {
        if (owners.get(key) === created) {
          owners.delete(key)
        }
      },
      () => {
        const current = owners.get(key)
        if (!current) {
          owners.set(key, created)
        }
        return current ?? created
      }
    )
    owner = created
  }
  return owner
}

export function resetStructuredAgentSessionTurnCompletionFeedsForTests(): void {
  // Stop subscription/reconnect before dropping map or unheld streams leak into the next test.
  for (const owner of owners.values()) {
    owner.stop()
  }
  owners.clear()
}
