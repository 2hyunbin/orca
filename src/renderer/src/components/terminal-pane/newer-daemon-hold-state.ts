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

const heldPanes = new Map<string, HeldPane>()
// Why per pane: a pane held after a failed attempt has not failed anything yet.
const failedPanes = new WeakSet<HeldPane>()
let reopening = false
let releaseSubscription: (() => void) | null = null
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

/** Registers a held pane; the returned teardown forgets it if it unmounts while held. */
export function holdPaneForNewerDaemon(paneKey: string, pane: HeldPane): () => void {
  // Why: main announces a confirmed stop; this window's own click releases on its reply instead.
  releaseSubscription ??= window.api.pty.onNewerDaemonReleased(() => {
    if (!reopening) {
      void releaseHeldPanes()
    }
  })
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
  if (!pane) {
    return null
  }
  const phase = reopening ? 'reopening' : failedPanes.has(pane) ? 'failed' : 'held'
  return { resumable: pane.resumable, phase }
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
  if (reopening) {
    return
  }
  reopening = true
  notify()
  let reopened = false
  try {
    reopened = (await window.api.pty.reopenNewerDaemonTerminals()).reopened
  } catch {
    reopened = false
  }
  reopening = false
  if (!reopened) {
    for (const pane of heldPanes.values()) {
      failedPanes.add(pane)
    }
    notify()
    return
  }
  announceReopenedTerminals(await releaseHeldPanes())
}

/** Test seam: module state outlives a test file's renders. */
export function resetNewerDaemonHoldStateForTests(): void {
  heldPanes.clear()
  reopening = false
  releaseSubscription?.()
  releaseSubscription = null
  notify()
}
