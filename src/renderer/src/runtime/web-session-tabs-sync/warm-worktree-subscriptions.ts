import { getWindowParkVisible, subscribeWindowParkVisibility } from '@/lib/window-park-visibility'
import { getRuntimeEnvironmentRevision } from '../runtime-environment-revision'
import type { WindowVisibilitySubscriptionParking } from '../window-visibility-subscription-parking'
import {
  installActiveSessionTabsSubscription,
  type ActiveSubscriptionArgs
} from './active-session-subscription'

// Why 3: the selected worktree plus the two it is most often toggled with stay warm.
export const WARM_WORKTREE_SESSION_SUBSCRIPTION_LIMIT = 3

type WarmEntry = {
  environmentId: string
  identity: string
  pairingRevision: number | undefined
  subscription: WindowVisibilitySubscriptionParking
}

export type WarmWorktreeSessionSubscriptions = {
  /** Make this worktree's stream current, reusing a warm one installed for the same connection. */
  select: (args: ActiveSubscriptionArgs, runtimeId: string | null) => void
  /** The host answered again: restart only streams that ended, never a live one. */
  restartEnded: (environmentId: string) => void
  dispose: () => void
}

/**
 * Per-worktree `session.tabs.subscribe` streams, kept warm across worktree switches. Reinstalling
 * on every switch cost a subscribe round trip and a snapshot re-apply per switch on SSH hosts.
 */
export function createWarmWorktreeSessionSubscriptions(): WarmWorktreeSessionSubscriptions {
  // Map order is recency: the last entry is the selected worktree's stream.
  const entries = new Map<string, WarmEntry>()
  let selectedKey: string | null = null

  const drop = (key: string): void => {
    const entry = entries.get(key)
    entries.delete(key)
    entry?.subscription()
  }
  const dropUnselected = (): void => {
    for (const key of entries.keys()) {
      if (key !== selectedKey) {
        drop(key)
      }
    }
  }
  // Why: a hidden window parks every stream and a reveal resumes each one without stagger, so
  // warm streams would multiply the reveal's round trips.
  const unsubscribeVisibility = subscribeWindowParkVisibility(() => {
    if (!getWindowParkVisible()) {
      dropUnselected()
    }
  })

  return {
    select: (args, runtimeId) => {
      if (!args.workspaceSessionReady) {
        selectedKey = null
        dropUnselected()
        return
      }
      const environmentId = args.activeWorktreeRuntimeEnvironmentId?.trim()
      const identity = `${args.activeWorktreeRuntimeConnectionGeneration}\u0000${runtimeId ?? ''}\u0000${args.activeWorktreeRuntimePairingRevision ?? ''}`
      for (const [key, entry] of entries) {
        // A new runtime session or re-pair invalidates every stream cut from the old one.
        if (
          (entry.environmentId === environmentId && entry.identity !== identity) ||
          getRuntimeEnvironmentRevision(entry.environmentId) !== entry.pairingRevision
        ) {
          drop(key)
        }
      }
      const key =
        environmentId && args.activeWorktreeId
          ? `${environmentId}\u0000${args.activeWorktreeId}`
          : null
      selectedKey = key
      if (!key || !environmentId) {
        return
      }
      const warm = entries.get(key)
      if (warm) {
        entries.delete(key)
        entries.set(key, warm)
      } else {
        const subscription = installActiveSessionTabsSubscription(args)
        if (!subscription) {
          return
        }
        entries.set(key, {
          environmentId,
          identity,
          pairingRevision: args.activeWorktreeRuntimePairingRevision,
          subscription
        })
      }
      for (const oldest of entries.keys()) {
        if (entries.size <= WARM_WORKTREE_SESSION_SUBSCRIPTION_LIMIT) {
          break
        }
        drop(oldest)
      }
    },
    restartEnded: (environmentId) => {
      for (const entry of entries.values()) {
        if (entry.environmentId === environmentId) {
          entry.subscription.restartEnded()
        }
      }
    },
    dispose: () => {
      unsubscribeVisibility()
      selectedKey = null
      for (const key of entries.keys()) {
        drop(key)
      }
    }
  }
}
