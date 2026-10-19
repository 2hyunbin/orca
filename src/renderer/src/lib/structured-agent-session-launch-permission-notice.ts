import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { isAgentChatPermissionMode } from '../../../shared/agent-chat-permission-mode'
import { nativeChatPermissionModeLabel } from '@/components/native-chat/native-chat-permission-mode-labels'

/** Why a paired host may not run this chat: it would not apply the permission mode asked for. */
export function hostPermissionRefusedText(
  agentLabel: string,
  kind: 'refused' | 'unverified',
  requested: unknown = useAppStore.getState().settings?.nativeChatPermissionMode
): string {
  return kind === 'unverified'
    ? translate(
        'components.native-chat.hostPermission.unverified',
        "Orca couldn't confirm this host applies chat permissions. Reconnect to it to send."
      )
    : translate(
        'components.native-chat.hostPermission.outdatedHost',
        'This host runs an older Orca that ignores chat permissions, so {{value0}} would run here without asking. Update Orca on this host to use {{value1}}.',
        {
          value0: agentLabel,
          value1: nativeChatPermissionModeLabel(
            isAgentChatPermissionMode(requested) ? requested : 'ask'
          )
        }
      )
}
