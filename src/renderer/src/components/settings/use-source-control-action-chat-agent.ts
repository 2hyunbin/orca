import { useEffect, useSyncExternalStore } from 'react'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY as CATALOG } from '../../../../shared/protocol-version'
import {
  isNativeChatEnabled,
  isNativeChatDefaultFor
} from '../../../../shared/structured-native-chat-launch-route'
import {
  readHostStructuredAgentsForRuntime,
  hostStructuredAgentsReadFailed,
  relearnHostStructuredAgents
} from '@/runtime/host-structured-agents'
import {
  readLocalRuntimeCapabilityObservation,
  subscribeLocalRuntimeCapabilityObservation
} from '@/runtime/local-runtime-capabilities'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isCustomAgentId } from '../../../../shared/commit-message-agent-spec'
import { pickSourceControlLaunchAgent } from '../../../../shared/source-control-launch-agent-selection'
import type { SourceControlActionRecipe } from '../../../../shared/source-control-ai-actions'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { readNativeDetectedAgents } from '@/store/slices/local-detected-agent-store-state'
import { useAppStore } from '@/store'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { chatProviderAgents, useHostStructuredAgentsVersion } from '@/lib/chat-provider-agents'

type ActionChatAgent =
  | { status: 'pending' }
  | { status: 'ready'; agent: TuiAgent | null; chat: boolean }

export function useSourceControlActionAgentInventory(enabled = true): void {
  const ensure = useAppStore((state) => state.ensureNativeDetectedAgents)
  const chatEnabled = useAppStore((state) => isNativeChatEnabled(state.settings))
  useEffect(() => {
    if (enabled) {
      void ensure()
      if (chatEnabled) {
        void relearnHostStructuredAgents(LOCAL_EXECUTION_HOST_ID, null, undefined)
      }
    }
  }, [enabled, ensure, chatEnabled])
}

export function useSourceControlActionChatAgent(
  selected: SourceControlActionRecipe['agentId'],
  defaultAgent: GlobalSettings['defaultTuiAgent']
): ActionChatAgent & { resolve: (agent: SourceControlActionRecipe['agentId']) => ActionChatAgent } {
  const settings = useAppStore((state) => state.settings)
  const detected = useAppStore(readNativeDetectedAgents)
  useHostStructuredAgentsVersion()
  const capabilities = useSyncExternalStore(
    subscribeLocalRuntimeCapabilityObservation,
    readLocalRuntimeCapabilityObservation,
    readLocalRuntimeCapabilityObservation
  )
  const providers = chatProviderAgents(LOCAL_EXECUTION_HOST_ID, undefined)
  const resolve = (selected: SourceControlActionRecipe['agentId']): ActionChatAgent => {
    if (detected === null) {
      return { status: 'pending' }
    }
    const savedAgent = selected && !isCustomAgentId(selected) ? selected : null
    const agent = pickSourceControlLaunchAgent({
      savedAgent,
      defaultAgent,
      detectedAgents: detected,
      disabledAgents: settings?.disabledTuiAgents
    })
    if (
      agent &&
      isNativeChatDefaultFor(settings, agent) &&
      agent !== 'claude' &&
      agent !== 'codex' &&
      !readHostStructuredAgentsForRuntime(LOCAL_EXECUTION_HOST_ID, null) &&
      !hostStructuredAgentsReadFailed(LOCAL_EXECUTION_HOST_ID, null) &&
      (capabilities.state === 'unlearned' ||
        capabilities.state === 'pending' ||
        (capabilities.state === 'known' && capabilities.capabilities.includes(CATALOG)))
    ) {
      return { status: 'pending' }
    }
    return {
      status: 'ready',
      agent,
      chat: !!agent && providers.includes(agent) && isNativeChatDefaultFor(settings, agent)
    }
  }
  return { ...resolve(selected), resolve }
}
