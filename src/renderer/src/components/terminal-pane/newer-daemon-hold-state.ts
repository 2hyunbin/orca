import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/** What one held pane did once released through the normal restore path. */
export type HeldPaneReopenOutcome = { reopened: boolean; agentResumed: boolean }

type HeldPane = {
  /** The cold-restore resume test passed when the pane was held. */
  resumable: boolean
  release: () => Promise<HeldPaneReopenOutcome>
}

export type NewerDaemonHoldPhase = 'held' | 'reopening' | 'failed'

// Why a phase per pane: a pane held after a failed attempt has not failed anything yet.
const heldPanes = new Map<string, HeldPane & { phase: NewerDaemonHoldPhase }>()
let version = 0
const listeners = new Set<() => void>()

function notify(): void {
  version += 1
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

async function releaseHeldPanes(): Promise<HeldPaneReopenOutcome[]> {
  const released = [...heldPanes.values()]
  heldPanes.clear()
  notify()
  return Promise.all(
    released.map((pane) =>
      pane.release().catch((): HeldPaneReopenOutcome => ({ reopened: false, agentResumed: false }))
    )
  )
}

function setPhase(
  panes: readonly { phase: NewerDaemonHoldPhase }[],
  phase: NewerDaemonHoldPhase
): void {
  for (const pane of panes) {
    pane.phase = phase
  }
  notify()
}

/** Registers a held pane; the returned teardown forgets it if it unmounts while held. */
export function holdPaneForNewerDaemon(paneKey: string, pane: HeldPane): () => void {
  const entry: HeldPane & { phase: NewerDaemonHoldPhase } = { ...pane, phase: 'held' }
  heldPanes.set(paneKey, entry)
  notify()
  return () => {
    if (heldPanes.get(paneKey) === entry) {
      heldPanes.delete(paneKey)
      notify()
    }
  }
}

export function useNewerDaemonHold(
  paneKey: string
): { resumable: boolean; phase: NewerDaemonHoldPhase } | null {
  useSyncExternalStore(subscribe, () => version)
  const pane = heldPanes.get(paneKey)
  return pane ? { resumable: pane.resumable, phase: pane.phase } : null
}

export function announceReopenedTerminals(outcomes: readonly HeldPaneReopenOutcome[]): void {
  const reopened = outcomes.filter((outcome) => outcome.reopened).length
  if (reopened === 0) {
    return
  }
  const resumed = outcomes.filter((outcome) => outcome.reopened && outcome.agentResumed).length
  const title =
    reopened === 1
      ? translate('terminal.newerDaemonBanner.reopenedOne', 'Reopened 1 terminal')
      : translate('terminal.newerDaemonBanner.reopenedOther', 'Reopened {{count}} terminals', {
          count: reopened
        })
  const description =
    resumed === 0
      ? undefined
      : resumed === 1
        ? translate('terminal.newerDaemonBanner.resumedOne', '1 agent session resumed.')
        : translate(
            'terminal.newerDaemonBanner.resumedOther',
            '{{count}} agent sessions resumed.',
            {
              count: resumed
            }
          )
  toast.success(title, description ? { description } : undefined)
}

/** Stops the newer daemon, then lets every held pane through its normal restore path. */
export async function reopenHeldTerminals(): Promise<void> {
  const attempt = [...heldPanes.values()]
  if (attempt.some((pane) => pane.phase === 'reopening')) {
    return
  }
  setPhase(attempt, 'reopening')
  let reopened = false
  try {
    reopened = (await window.api.pty.reopenNewerDaemonTerminals()).reopened
  } catch {
    reopened = false
  }
  if (!reopened) {
    setPhase(attempt, 'failed')
    return
  }
  announceReopenedTerminals(await releaseHeldPanes())
}

/** Test seam: module state outlives a test file's renders. */
export function resetNewerDaemonHoldStateForTests(): void {
  heldPanes.clear()
  notify()
}
