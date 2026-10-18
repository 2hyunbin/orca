import { useAppStore } from '../../store'

/** Keeps auth status and the waiting sign-in link in step with main. */
export function registerOrcaProfileAuthIpcBridge(unsubs: (() => void)[]): void {
  const api = window.api.orcaProfiles
  if (typeof api?.onAuthStatusChanged === 'function') {
    unsubs.push(
      api.onAuthStatusChanged(() => {
        void useAppStore.getState().fetchOrcaProfileAuthStatus()
      })
    )
  }
  if (typeof api?.onSignInLinkChanged === 'function') {
    let changed = false
    unsubs.push(
      api.onSignInLinkChanged((link) => {
        changed = true
        useAppStore.setState({ orcaProfileSignInLink: link })
      })
    )
    // Why: a sign-in can already be waiting when this window loads; a later event wins.
    void api
      .pendingSignInLink()
      .then((link) => {
        if (!changed) {
          useAppStore.setState({ orcaProfileSignInLink: link })
        }
      })
      .catch(() => {})
  }
}
