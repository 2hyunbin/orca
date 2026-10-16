import { useEffect, useState } from 'react'
import { agentChatPermissionModes } from '../../../shared/agent-chat-permission-mode'
import {
  chatPermissionHostVerdict,
  hostSettingsApplyChatPermissionModes,
  legacyHostChatPermissionMode,
  type ChatPermissionHostVerdict
} from '../../../shared/agent-chat-permission-host-support'
import { AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY } from '../../../shared/agent-session-permission-modes-capability'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { useAppStore } from '@/store'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { subscribeRuntimeHostContactRegained } from './runtime-host-contact-regained'

/** `unverified`: the host could not say what it runs, so nothing may start there yet. */
export type StructuredChatHostPermissionVerdict = ChatPermissionHostVerdict | { kind: 'unverified' }

const HOST_PERMISSION_READ_TIMEOUT_MS = 15_000

/** The mode this client asks new chats to start in; on a paired host that predates per-chat modes
 *  it is the only stated intent, since that host keeps none. */
function requestedChatPermissionMode(): unknown {
  return useAppStore.getState().settings?.nativeChatPermissionMode
}

/**
 * Whether a chat on `target` may start or take a turn without running with more access than this
 * client asks for. A paired host that does not apply per-chat modes runs its Agent Permissions.
 */
export async function readStructuredChatHostPermissionVerdict(
  target: RuntimeClientTarget,
  agent: string,
  requested: unknown = requestedChatPermissionMode()
): Promise<StructuredChatHostPermissionVerdict> {
  if (target.kind === 'local' || !agentChatPermissionModes(agent)) {
    return { kind: 'allowed' }
  }
  const advertised = await runtimeEnvironmentSupportsCapability(
    target.environmentId,
    AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY,
    HOST_PERMISSION_READ_TIMEOUT_MS
  ).catch(() => false)
  if (advertised) {
    return { kind: 'allowed' }
  }
  let settings: unknown
  try {
    const result = await callRuntimeRpc<{ settings?: unknown }>(target, 'settings.get', undefined, {
      timeoutMs: HOST_PERMISSION_READ_TIMEOUT_MS
    })
    settings = result.settings
  } catch {
    return { kind: 'unverified' }
  }
  return chatPermissionHostVerdict({
    agent,
    hostAppliesModes: hostSettingsApplyChatPermissionModes(settings),
    legacyMode: legacyHostChatPermissionMode(agent, settings),
    requested
  })
}

/** `checking` until the host has answered; asked again on each regained contact and change of
 *  the requested mode, so an updated host is let through without a reload. */
export function useStructuredChatHostPermissionVerdict(
  target: RuntimeClientTarget,
  agent: string
): StructuredChatHostPermissionVerdict | { kind: 'checking' } {
  const gated = target.kind === 'environment' && agentChatPermissionModes(agent) !== null
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const requested = useAppStore((state) => state.settings?.nativeChatPermissionMode)
  const key = `${environmentId ?? 'local'}\0${agent}\0${String(requested)}`
  const [answer, setAnswer] = useState<{
    key: string
    verdict: StructuredChatHostPermissionVerdict
  } | null>(null)
  const [contact, setContact] = useState(0)
  useEffect(() => {
    if (!gated || environmentId === null) {
      return
    }
    return subscribeRuntimeHostContactRegained(environmentId, () => setContact((n) => n + 1))
  }, [environmentId, gated])
  useEffect(() => {
    if (!gated || environmentId === null) {
      return
    }
    let cancelled = false
    void readStructuredChatHostPermissionVerdict(
      { kind: 'environment', environmentId },
      agent,
      requested
    ).then((verdict) => {
      if (!cancelled) {
        setAnswer({ key, verdict })
      }
    })
    return () => {
      cancelled = true
    }
  }, [agent, contact, environmentId, gated, key, requested])
  if (!gated) {
    return { kind: 'allowed' }
  }
  return answer?.key === key ? answer.verdict : { kind: 'checking' }
}
