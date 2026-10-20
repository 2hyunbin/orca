import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { agentSessionSignInFor } from '../../../../shared/agent-session-sign-in'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'

export function nativeChatAntigravitySettingsAction(
  failureKind: string | undefined,
  agentName: string | undefined
): NativeChatComposerNotice['action'] {
  if (failureKind !== 'notSignedIn' || agentSessionSignInFor(agentName)?.agent !== 'antigravity') {
    return undefined
  }
  return {
    label: translate(
      'components.native-chat.antigravitySignIn.openSettings',
      'Open Antigravity settings'
    ),
    onClick: () => {
      const { openSettingsTarget, openSettingsPage } = useAppStore.getState()
      openSettingsTarget({ pane: 'accounts', repoId: null, sectionId: 'accounts-antigravity' })
      openSettingsPage()
    }
  }
}
