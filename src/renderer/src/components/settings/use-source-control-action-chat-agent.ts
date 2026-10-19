import type { TuiAgent } from '../../../../shared/tui-agent'
import { isCustomAgentId } from '../../../../shared/commit-message-agent-spec'
import { isNativeChatDefaultFor } from '../../../../shared/structured-native-chat-launch-route'
import { pickSourceControlLaunchAgent } from '../../../../shared/source-control-launch-agent-selection'
import type { SourceControlActionRecipe } from '../../../../shared/source-control-ai-actions'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { readNativeDetectedAgents } from '@/store/slices/local-detected-agent-store-state'
import { useAppStore } from '@/store'
import { useLocalChatAgents } from './NativeChatProvidersSetting'

type ActionChatAgent = { agent: TuiAgent | null | undefined; loading: boolean; chat: boolean }

export function useSourceControlActionChatAgent(
  selected: SourceControlActionRecipe['agentId'],
  defaultAgent: GlobalSettings['defaultTuiAgent']
): ActionChatAgent & { resolve: (agent: SourceControlActionRecipe['agentId']) => ActionChatAgent } {
  const settings = useAppStore((state) => state.settings)
  const detected = useAppStore(readNativeDetectedAgents)
  const providers = useLocalChatAgents()
  const resolve = (selected: SourceControlActionRecipe['agentId']) => {
    const savedAgent = selected && !isCustomAgentId(selected) ? selected : null
    const agent =
      detected === null
        ? (savedAgent ?? (defaultAgent === 'blank' ? null : defaultAgent))
        : pickSourceControlLaunchAgent({
            savedAgent,
            defaultAgent,
            detectedAgents: detected,
            disabledAgents: settings?.disabledTuiAgents
          })
    return {
      agent,
      loading: detected === null,
      chat: !!agent && providers.includes(agent) && isNativeChatDefaultFor(settings, agent)
    }
  }
  return { ...resolve(selected), resolve }
}
