import { useEffect } from 'react'
import { subscribeStructuredAttentionViews } from '@/attention/agent-subject-read-actions'
import {
  subscribeAutoAckPresenceSignals,
  subscribeTerminalInputPresence
} from './agent-auto-ack-presence'
import { useAppStore } from '@/store'
import { isWebClientLocation } from '@/lib/web-client-location'
import { startViewedAttentionScan } from './viewed-attention-scan'
export { resolveAutoAckTabTargets, type AutoAckTabTarget } from './agent-auto-ack-targets'

/** Reads what is on screen: acknowledges the visible agents and reads the visible tabs' markers. */
export function useAutoAckViewedAgent(): void {
  useEffect(
    () =>
      startViewedAttentionScan(useAppStore, {
        // Browsers have no native idle capability; their visible/focused gates still apply.
        readDesktopAway: isWebClientLocation()
          ? null
          : async () => window.api?.notifications?.getDesktopAwayState?.(),
        subscribeStructuredViews: subscribeStructuredAttentionViews,
        subscribePresenceSignals: subscribeAutoAckPresenceSignals,
        subscribeTerminalInput: subscribeTerminalInputPresence
      }),
    []
  )
}
