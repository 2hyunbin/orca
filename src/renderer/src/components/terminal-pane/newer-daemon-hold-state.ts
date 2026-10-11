import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/** What one held pane did once released through the normal restore path. */
export type HeldPaneReopenOutcome = { reopened: boolean; agentResumed: boolean }

export type NewerDaemonHoldPhase = 'held' | 'reopening' | 'failed'

type HeldPane = {
  /** The cold-restore resume test passed when the pane was held. */
  resumable: boolean
  // Why a phase per pane: a pane held after a failed attempt has not failed anything yet.
  phase: NewerDaemonHoldPhase
  release: () => Promise<HeldPaneReopenOutcome>
}

export const newerDaemonHoldStore = createStore<{ panes: Record<string, HeldPane> }>(() => ({
  panes: {}
}))

function setPhase(paneKeys: readonly string[], phase: NewerDaemonHoldPhase): void {
  newerDaemonHoldStore.setState(({ panes }) => ({
    panes: Object.fromEntries(
      Object.entries(panes).map(([key, pane]) => [
        key,
        paneKeys.includes(key) ? { ...pane, phase } : pane
      ])
    )
  }))
}

/** Registers a held pane; the returned teardown forgets it if it unmounts while held. */
export function holdPaneForNewerDaemon(paneKey: string, pane: Omit<HeldPane, 'phase'>): () => void {
  newerDaemonHoldStore.setState(({ panes }) => ({
    panes: { ...panes, [paneKey]: { ...pane, phase: 'held' } }
  }))
  return () =>
    newerDaemonHoldStore.setState(({ panes }) => {
      if (panes[paneKey]?.release !== pane.release) {
        return {}
      }
      const { [paneKey]: _forgotten, ...rest } = panes
      return { panes: rest }
    })
}

export function useNewerDaemonHold(
  paneKey: string
): { resumable: boolean; phase: NewerDaemonHoldPhase } | null {
  const pane = useStore(newerDaemonHoldStore, (state) => state.panes[paneKey])
  return pane ? { resumable: pane.resumable, phase: pane.phase } : null
}

export function announceReopenedTerminals(outcomes: readonly HeldPaneReopenOutcome[]): void {
  const reopened = outcomes.filter((outcome) => outcome.reopened).length
  if (reopened === 0) {
    return
  }
  const resumed = outcomes.filter((outcome) => outcome.reopened && outcome.agentResumed).length
  toast.success(
    translate('terminal.newerDaemonBanner.reopened', 'Reopened {{count}} terminals', {
      count: reopened
    }),
    resumed > 0
      ? {
          description: translate(
            'terminal.newerDaemonBanner.resumed',
            '{{count}} agent sessions resumed.',
            { count: resumed }
          )
        }
      : undefined
  )
}

/** Stops the newer daemon, then lets every held pane through its normal restore path. */
export async function reopenHeldTerminals(): Promise<void> {
  const { panes } = newerDaemonHoldStore.getState()
  const attempt = Object.keys(panes)
  if (Object.values(panes).some((pane) => pane.phase === 'reopening')) {
    return
  }
  setPhase(attempt, 'reopening')
  const reopened = await window.api.pty.reopenNewerDaemonTerminals().then(
    (result) => result.reopened,
    () => false
  )
  if (!reopened) {
    setPhase(attempt, 'failed')
    return
  }
  const released = Object.values(newerDaemonHoldStore.getState().panes)
  newerDaemonHoldStore.setState({ panes: {} })
  const outcomes = await Promise.all(
    released.map((pane) =>
      pane.release().catch((): HeldPaneReopenOutcome => ({ reopened: false, agentResumed: false }))
    )
  )
  announceReopenedTerminals(outcomes)
}
