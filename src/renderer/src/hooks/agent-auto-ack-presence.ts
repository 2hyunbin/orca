import { MOBILE_NOTIFICATION_AWAY_SECONDS } from '../../../shared/desktop-away-threshold'

// The one record of user presence: the on-screen scan's gate and the marking guard both read it,
// so a subject on screen is skipped by marking only when the scan would read it right away.
let presenceGated = true
let presentAt = Number.NEGATIVE_INFINITY

/** False where there is no native idle query (browsers): the window gate stands alone. */
export function setPresenceGated(gated: boolean): void {
  presenceGated = gated
  presentAt = Number.NEGATIVE_INFINITY
}

/** Trusted input, or main reporting the desktop active. */
export function notePresence(): void {
  presentAt = Date.now()
}

/** Present within main's away threshold; unknown or away until proven. */
export function isPresenceConfirmed(): boolean {
  return !presenceGated || Date.now() - presentAt < MOBILE_NOTIFICATION_AWAY_SECONDS * 1000
}

export function createAutoAckPresenceCheck(
  readAway: () => Promise<boolean | undefined>,
  onPresent: () => void
): { request: () => void; dispose: () => void } {
  let disposed = false
  let pending = false
  return {
    request() {
      if (disposed || pending) {
        return
      }
      pending = true
      void readAway()
        .then((away) => {
          // Unknown presence must not clear unread attention.
          if (away !== false) {
            presentAt = Number.NEGATIVE_INFINITY
            return
          }
          notePresence()
          if (!disposed) {
            onPresent()
          }
        })
        .catch(() => {})
        .finally(() => {
          pending = false
        })
    },
    dispose() {
      disposed = true
    }
  }
}

export function subscribeAutoAckPresenceSignals(
  onRescan: () => void,
  onInput: () => void
): () => void {
  const input = (event: Event): void => {
    if (event.isTrusted) {
      onInput()
    }
  }
  document.addEventListener('visibilitychange', onRescan)
  window.addEventListener('focus', onRescan)
  window.addEventListener('pointerdown', input)
  window.addEventListener('pointermove', input)
  // Why capture: xterm stops the keydowns it handles before they bubble to the window.
  window.addEventListener('keydown', input, { capture: true })
  return () => {
    document.removeEventListener('visibilitychange', onRescan)
    window.removeEventListener('focus', onRescan)
    window.removeEventListener('pointerdown', input)
    window.removeEventListener('pointermove', input)
    window.removeEventListener('keydown', input, { capture: true })
  }
}
