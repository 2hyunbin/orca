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
    // Why: a sign-in can already be waiting when this window loads; a later event or teardown wins.
    let ignoreSnapshot = false
    const unsubscribe = api.onSignInLinkChanged((link) => {
      ignoreSnapshot = true
      useAppStore.setState({ orcaProfileSignInLink: link })
    })
    unsubs.push(() => {
      ignoreSnapshot = true
      unsubscribe()
    })
    void Promise.resolve()
      .then(() => api.pendingSignInLink())
      .then((link) => {
        if (!ignoreSnapshot) {
          useAppStore.setState({ orcaProfileSignInLink: link ?? null })
        }
      })
      .catch(() => {})
  }
}
