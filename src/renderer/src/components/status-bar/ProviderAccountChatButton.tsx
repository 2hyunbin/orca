import type { ComponentProps } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export const LOCAL_ACCOUNT_TARGET: RuntimeClientTarget = { kind: 'local' }

/** A chat's account action always applies to this computer's native runtime. */
export type ChatAccountAction = { disabled: boolean }

export function ProviderAccountChatButton({
  provider,
  add = false,
  disabled,
  ...buttonProps
}: ComponentProps<typeof Button> & {
  provider: 'claude' | 'codex'
  add?: boolean
  disabled: boolean
}): React.JSX.Element {
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  return (
    <Button
      {...buttonProps}
      type="button"
      variant="outline"
      size="xs"
      disabled={disabled}
      onClick={
        add
          ? () => {
              openSettingsTarget({
                pane: 'accounts',
                repoId: null,
                sectionId: `accounts-${provider}`
              })
              openSettingsPage()
            }
          : buttonProps.onClick
      }
    >
      {add
        ? translate('components.native-chat.usageLimitActions.addAccount', 'Add Account…')
        : translate('components.native-chat.usageLimitActions.switchAccount', 'Switch Account')}
    </Button>
  )
}

export function providerChatAccountControl(
  provider: 'claude' | 'codex',
  action: ChatAccountAction | undefined,
  loaded: boolean,
  signedInCount: number,
  busy: boolean
): { add: boolean; button: React.JSX.Element } | undefined {
  if (!action) {
    return undefined
  }
  const add = loaded && signedInCount <= 1
  return {
    add,
    button: (
      <ProviderAccountChatButton
        provider={provider}
        add={add}
        disabled={action.disabled || !loaded || busy}
      />
    )
  }
}
