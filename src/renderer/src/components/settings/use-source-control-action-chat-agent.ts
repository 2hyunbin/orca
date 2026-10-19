import { useEffect } from 'react'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isCustomAgentId } from '../../../../shared/commit-message-agent-spec'
import { isNativeChatDefaultFor } from '../../../../shared/structured-native-chat-launch-route'
import { pickSourceControlLaunchAgent } from '../../../../shared/source-control-launch-agent-selection'
import type { SourceControlActionRecipe } from '../../../../shared/source-control-ai-actions'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { readNativeDetectedAgents } from '@/store/slices/local-detected-agent-store-state'
import { useAppStore } from '@/store'
import { useLocalChatAgents } from './NativeChatProvidersSetting'

type ActionChatAgent =
  | { status: 'pending' }
  | { status: 'ready'; agent: TuiAgent | null; chat: boolean }

export function useSourceControlActionAgentInventory(enabled = true): void {
  const ensure = useAppStore((state) => state.ensureNativeDetectedAgents)
  useEffect(() => {
    if (enabled) {
      void ensure()
    }
  }, [enabled, ensure])
}

export function useSourceControlActionChatAgent(
  selected: SourceControlActionRecipe['agentId'],
  defaultAgent: GlobalSettings['defaultTuiAgent']
): ActionChatAgent & { resolve: (agent: SourceControlActionRecipe['agentId']) => ActionChatAgent } {
  const settings = useAppStore((state) => state.settings)
  const detected = useAppStore(readNativeDetectedAgents)
  const providers = useLocalChatAgents()
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
    return {
      status: 'ready',
      agent,
      chat: !!agent && providers.includes(agent) && isNativeChatDefaultFor(settings, agent)
    }
  }
  return { ...resolve(selected), resolve }
}
