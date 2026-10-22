import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { subscribeLocalRuntimeCapabilityObservation } from '@/runtime/local-runtime-capabilities'
import { supportsInPlaceSwitch } from '@/runtime/structured-agent-session-client'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import {
  onRuntimeEnvironmentRevisionsChanged,
  onRuntimeEnvironmentsRetired
} from '@/runtime/runtime-environment-revision'
import { inPlaceSwitchEnabled } from '../../../shared/structured-agent-cli-conversation-adoption'
import type { AiVaultAgent } from '../../../shared/ai-vault-types'

// The answer per host and agent; a reconnect or retirement asks again.
const known = new Map<string, boolean>()
const asking = new Map<string, Promise<boolean>>()
const listeners = new Set<() => void>()
let revision = 0
const changed = () => {
  revision += 1
  listeners.forEach((listener) => listener())
}
const forget = () => {
  known.clear()
  asking.clear()
  changed()
}
onRuntimeEnvironmentRevisionsChanged(forget)
onRuntimeEnvironmentsRetired(forget)
subscribeLocalRuntimeCapabilityObservation(forget)
let stopStatusSubscription: (() => void) | undefined
const subscribe = (listener: () => void) => {
  if (listeners.size === 0) {
    stopStatusSubscription = useAppStore.subscribe((state, previous) => {
      if (state.runtimeStatusByEnvironmentId !== previous.runtimeStatusByEnvironmentId) {
        forget()
      }
    })
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      stopStatusSubscription?.()
      stopStatusSubscription = undefined
    }
  }
}

export function useInPlaceSwitchRevision(): number {
  return useSyncExternalStore(
    subscribe,
    () => revision,
    () => 0
  )
}

/** The cached answer, asking in the background when there is none yet. */
export function inPlaceSwitchCapabilityNow(
  executionHostId: string | null | undefined,
  agent: string
): boolean | undefined {
  if (!inPlaceSwitchEnabled(agent)) {
    return false
  }
  const key = `${executionHostId ?? ''}\0${agent}`
  const answer = known.get(key)
  const target = structuredAgentSessionTargetForHost(executionHostId)
  if (answer === undefined && target && !asking.has(key)) {
    const attempt = supportsInPlaceSwitch(target, agent)
    asking.set(key, attempt)
    void attempt.then((supported) => {
      if (asking.get(key) !== attempt) {
        return
      }
      asking.delete(key)
      known.set(key, supported)
      changed()
    })
  }
  return answer
}

export function inPlaceSwitchSupportedNow(host: string | null | undefined, agent: string): boolean {
  return inPlaceSwitchCapabilityNow(host, agent) === true
}

/** Whether the host running this conversation switches it in place; false until it answered yes. */
export function useInPlaceSwitchCapability(
  executionHostId: string | null | undefined,
  agent: string | null | undefined
): boolean | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (agent ? inPlaceSwitchCapabilityNow(executionHostId, agent) : false),
    () => false
  )
}

export function useInPlaceSwitchSupported(
  host: string | null | undefined,
  agent: string | null | undefined
): boolean {
  return useInPlaceSwitchCapability(host, agent) === true
}

/** A History row's agent when its host switches it in place: the row offers the switch, not a copy. */
export function useAiVaultInPlaceAgent(session: {
  agent: AiVaultAgent
  executionHostId?: string | null
}): AiVaultAgent | undefined {
  return useInPlaceSwitchCapability(session.executionHostId, session.agent) !== false &&
    inPlaceSwitchEnabled(session.agent)
    ? session.agent
    : undefined
}
