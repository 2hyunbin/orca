import { Button } from '../ui/button'
import { translate } from '../../i18n/i18n'
import { useAppStore } from '../../store'
import { CopyOrcaSignInLinkButton, orcaSignInWaitingLabel } from '../OrcaSignInWaitNotice'

export function MobileRelaySignInPanel({
  reconnectRequired,
  onSignIn
}: {
  reconnectRequired: boolean
  onSignIn: () => void
}): React.JSX.Element {
  const link = useAppStore((state) => state.orcaProfileSignInLink)

  return (
    <div
      // Why role-less: a radiogroup may only own radios; this div is layout under the Relay radio.
      onKeyDown={(event) => {
        // Why: arrow keys on nested controls must not change the selected path.
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
          event.stopPropagation()
        }
      }}
      className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 bg-accent/40 py-2.5 pl-10 pr-3"
      data-testid="anywhere-sign-in-panel"
    >
      <p className="min-w-0 flex-1 text-xs text-muted-foreground" aria-live="polite">
        {link
          ? orcaSignInWaitingLabel()
          : translate(
              'auto.components.settings.MobilePairingConnectionOptions.relaySignInDetail',
              'Signs this desktop in to Orca and routes the phone through Orca’s servers. LAN does not need an account.'
            )}
      </p>
      <div className="flex shrink-0 items-center gap-2">
        {link ? <CopyOrcaSignInLinkButton link={link} /> : null}
        <Button type="button" size="sm" onClick={onSignIn}>
          {reconnectRequired
            ? translate(
                'auto.components.settings.MobilePairingConnectionOptions.signInAgain',
                'Sign in again for Relay'
              )
            : translate(
                'auto.components.settings.MobilePairingConnectionOptions.signIn',
                'Sign in for Relay'
              )}
        </Button>
      </div>
    </div>
  )
}
