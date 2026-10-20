import { useSyncExternalStore } from 'react'
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
const asking = new Set<string>()
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((listener) => listener())
const forget = () => {
  known.clear()
  changed()
}
onRuntimeEnvironmentRevisionsChanged(forget)
onRuntimeEnvironmentsRetired(forget)

/** The cached answer, asking in the background when there is none yet. */
export function inPlaceSwitchSupportedNow(
  executionHostId: string | null | undefined,
  agent: string
): boolean {
  if (!inPlaceSwitchEnabled(agent)) {
    return false
  }
  const key = `${executionHostId ?? ''}\0${agent}`
  const answer = known.get(key)
  const target = structuredAgentSessionTargetForHost(executionHostId)
  if (answer === undefined && target && !asking.has(key)) {
    asking.add(key)
    void supportsInPlaceSwitch(target, agent).then((supported) => {
      asking.delete(key)
      known.set(key, supported)
      changed()
    })
  }
  return answer === true
}

/** Whether the host running this conversation switches it in place; false until it answered yes. */
export function useInPlaceSwitchSupported(
  executionHostId: string | null | undefined,
  agent: string | null | undefined
): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => (agent ? inPlaceSwitchSupportedNow(executionHostId, agent) : false),
    () => false
  )
}

/** A History row's agent when its host switches it in place: the row offers the switch, not a copy. */
export function useAiVaultInPlaceAgent(session: {
  agent: AiVaultAgent
  executionHostId?: string | null
}): AiVaultAgent | undefined {
  return useInPlaceSwitchSupported(session.executionHostId, session.agent)
    ? session.agent
    : undefined
}
