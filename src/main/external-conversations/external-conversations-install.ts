import { registerWorktreeChangeInvalidator } from '../ipc/worktree-change-invalidators'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ExternalConversationLinkStore } from './external-conversation-links'
import { ExternalConversationSeam } from './external-conversation-seam'

export type ExternalConversationStore = ExternalConversationLinkStore & {
  getSettings: () => Partial<
    Pick<GlobalSettings, 'experimentalConnectors' | 'agentStatusHooksEnabled' | 'disabledTuiAgents'>
  >
  onSettingsChanged?: (listener: (updates: Partial<GlobalSettings>) => void) => unknown
}

/**
 * Owns the seam's lifetime: one exists exactly while `experimentalConnectors` is on. The flag is
 * first read on the first connector call, so a host that never sees one never reads it; a change
 * after that disposes or rebuilds the seam without waiting for another call. The host is the
 * authority, so every connector entry point asks it rather than its caller's profile.
 */
export function installExternalConversations(
  store: ExternalConversationStore | null,
  workspaces: { onWorktreeLifecycle: (listener: () => void) => () => void }
): { current(): ExternalConversationSeam | null } {
  if (!store) {
    return { current: () => null }
  }
  let seam: ExternalConversationSeam | null = null
  let reconciled = false
  const reconcile = (): void => {
    reconciled = true
    const enabled = store.getSettings().experimentalConnectors === true
    if (enabled && !seam) {
      seam = new ExternalConversationSeam({
        store,
        readSettings: () => store.getSettings(),
        // A removed, renamed or re-adopted workspace changes which record holds a link.
        subscribeInvalidations: (invalidate) => {
          const releaseLifecycle = workspaces.onWorktreeLifecycle(invalidate)
          const releaseChanges = registerWorktreeChangeInvalidator(invalidate)
          return () => {
            releaseLifecycle()
            releaseChanges()
          }
        }
      })
    } else if (!enabled && seam) {
      seam.dispose('connectors_disabled')
      seam = null
    }
  }
  store.onSettingsChanged?.((updates) => {
    if ('experimentalConnectors' in updates) {
      reconcile()
    }
  })
  return {
    current: () => {
      if (!reconciled) {
        reconcile()
      }
      return seam
    }
  }
}
