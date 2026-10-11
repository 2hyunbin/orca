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

/** One action stops the newer daemon for every held pane, so the phase is shared. */
export type NewerDaemonHoldPhase = 'held' | 'reopening' | 'failed'

const heldPanes = new Map<string, HeldPane>()
let phase: NewerDaemonHoldPhase = 'held'
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

/** Registers a held pane; the returned teardown forgets it if it unmounts while held. */
export function holdPaneForNewerDaemon(paneKey: string, pane: HeldPane): () => void {
  heldPanes.set(paneKey, pane)
  notify()
  return () => {
    if (heldPanes.get(paneKey) === pane) {
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
  return pane ? { resumable: pane.resumable, phase } : null
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
  if (phase === 'reopening') {
    return
  }
  phase = 'reopening'
  notify()
  let reopened = false
  try {
    reopened = (await window.api.pty.reopenNewerDaemonTerminals()).reopened
  } catch {
    reopened = false
  }
  if (!reopened) {
    phase = 'failed'
    notify()
    return
  }
  const released = [...heldPanes.values()]
  heldPanes.clear()
  phase = 'held'
  notify()
  const outcomes = await Promise.all(
    released.map((pane) =>
      pane.release().catch((): HeldPaneReopenOutcome => ({ reopened: false, agentResumed: false }))
    )
  )
  announceReopenedTerminals(outcomes)
}

/** Test seam: module state outlives a test file's renders. */
export function resetNewerDaemonHoldStateForTests(): void {
  heldPanes.clear()
  phase = 'held'
  notify()
}
