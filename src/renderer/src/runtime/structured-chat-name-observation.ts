import { useSyncExternalStore } from 'react'
import { shallow } from 'zustand/shallow'
import { useAppStore } from '@/store'
import { getStructuredAgentSessionTabs } from '@/components/native-chat/structured-agent-session-tabs'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionOwnerInputs,
  structuredAgentSessionTargetForHost
} from './structured-agent-session-owner'
import { getStructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'
import { readStructuredChatTabSavedName } from './structured-chat-tab-name'

const listeners = new Set<() => void>()
let snapshot = ''
let stopObserving: (() => void) | undefined
const getSnapshot = () => snapshot

function observe(): () => void {
  const feeds = new Map<string, () => void>()
  const notice = () => {
    const state = useAppStore.getState()
    const next = JSON.stringify(
      getStructuredAgentSessionTabs(state.unifiedTabsByWorktree).map((tab) => [
        tab.worktreeId,
        tab.id,
        tab.entityId,
        readStructuredChatTabSavedName(tab, state)
      ])
    )
    if (next !== snapshot) {
      snapshot = next
      listeners.forEach((listener) => listener())
    }
  }
  const reconcile = () => {
    const state = useAppStore.getState()
    const owners = new Set<string | null>(
      getStructuredAgentSessionTabs(state.unifiedTabsByWorktree).map((tab) =>
        structuredAgentSessionOwnerForTab(state, tab)
      )
    )
    for (const [owner, stop] of feeds) {
      if (!owners.has(owner)) {
        stop()
        feeds.delete(owner)
      }
    }
    for (const owner of owners) {
      const target = structuredAgentSessionTargetForHost(owner)
      if (!owner || !target || feeds.has(owner)) {
        continue
      }
      const feed = getStructuredAgentSessionStatusFeed(target)
      let names = feed.getNamingSnapshot()
      const stop = feed.subscribe(() => {
        const next = feed.getNamingSnapshot()
        if (names !== next) {
          names = next
          notice()
        }
      })
      const deactivate = feed.activate()
      feeds.set(owner, () => {
        stop()
        deactivate()
      })
    }
    notice()
  }
  const stopStore = useAppStore.subscribe((state, previous) => {
    if (
      state.unifiedTabsByWorktree !== previous.unifiedTabsByWorktree ||
      !shallow(
        structuredAgentSessionOwnerInputs(state),
        structuredAgentSessionOwnerInputs(previous)
      )
    ) {
      reconcile()
    }
  })
  reconcile()
  return () => {
    stopStore()
    feeds.forEach((stop) => stop())
  }
}

export function subscribeStructuredChatTabNames(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    stopObserving = observe()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      stopObserving?.()
      stopObserving = undefined
    }
  }
}

export function useStructuredChatTabNames(): string {
  return useSyncExternalStore(subscribeStructuredChatTabNames, getSnapshot, () => '')
}
