import { Button } from '../ui/button'
import { translate } from '../../i18n/i18n'
import { useAppStore } from '../../store'
import { CopyOrcaSignInLinkButton, orcaSignInWaitingLabel } from '../OrcaSignInWaitNotice'

/** The Relay sub-step that signs this desktop in to Orca. */
export function MobileRelaySignInPanel({
  reconnectRequired,
  onSignIn
}: {
  reconnectRequired: boolean
  onSignIn: () => void
}): React.JSX.Element {
  const pending = useAppStore((state) => state.orcaProfileSignInPending)

  return (
    <div
      // Why: indent under the Relay radio so Sign in reads as a Relay
      // sub-step, not a requirement for the whole connection section/LAN.
      // Deliberately role-less: a `group` here would be an invalid owned
      // element of the radiogroup, and its label would double-announce the
      // button it wraps. The plain div contributes nothing to the a11y
      // tree, leaving the CTA reachable by Tab as an ordinary button.
      onKeyDown={(event) => {
        // Why: nested controls live inside the radiogroup for layout; do not
        // let arrow keys bubble and flip the selected path.
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
          event.stopPropagation()
        }
      }}
      className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 bg-accent/40 py-2.5 pl-10 pr-3"
      data-testid="anywhere-sign-in-panel"
    >
      <p className="min-w-0 flex-1 text-xs text-muted-foreground" aria-live="polite">
        {pending
          ? orcaSignInWaitingLabel()
          : translate(
              'auto.components.settings.MobilePairingConnectionOptions.relaySignInDetail',
              'Signs this desktop in to Orca and routes the phone through Orca’s servers. LAN does not need an account.'
            )}
      </p>
      <div className="flex shrink-0 items-center gap-2">
        {pending ? <CopyOrcaSignInLinkButton /> : null}
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
