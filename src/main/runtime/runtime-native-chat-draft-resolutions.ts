import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeNativeChatLaunchDraftResolution
} from '../../shared/runtime-types'
import { runtimeWorktreeIdsEqual } from './runtime-worktree-path-identity'

type DraftResolutionTombstone = RuntimeNativeChatLaunchDraftResolution & { worktreeId: string }

type RuntimeNativeChatDraftResolutionsDeps = {
  resolveOwner: (handle: string) => { tabId: string; worktreeId: string } | null
  scheduleMobileSnapshot: (worktreeId: string) => void
  notifyResolved: (
    tabId: string,
    resolution: { text: string; createdAt: number },
    event: RuntimeClientEvent
  ) => void
}

const MAX_TOMBSTONES = 200

export class RuntimeNativeChatDraftResolutions {
  private readonly byTabId = new Map<string, DraftResolutionTombstone>()

  constructor(private readonly deps: RuntimeNativeChatDraftResolutionsDeps) {}

  snapshot(): Extract<RuntimeClientEvent, { type: 'nativeChatLaunchDraftResolved' }>[] {
    return [...this.byTabId.values()]
      .sort((a, b) => a.tabId.localeCompare(b.tabId))
      .map(({ tabId, text, createdAt }) => ({
        type: 'nativeChatLaunchDraftResolved',
        tabId,
        text,
        createdAt
      }))
  }

  notify(handle: string, resolution: { text: string; createdAt: number }): void {
    const owner = this.deps.resolveOwner(handle)
    if (!owner) {
      return
    }
    const tombstone = { ...owner, ...resolution }
    this.byTabId.delete(owner.tabId)
    this.byTabId.set(owner.tabId, tombstone)
    while (this.byTabId.size > MAX_TOMBSTONES) {
      const oldestTabId = this.byTabId.keys().next().value
      if (typeof oldestTabId !== 'string') {
        break
      }
      this.byTabId.delete(oldestTabId)
    }
    this.retireFromMobileSnapshot(tombstone)
    this.deps.notifyResolved(owner.tabId, resolution, {
      type: 'nativeChatLaunchDraftResolved',
      tabId: owner.tabId,
      ...resolution
    })
  }

  applyFence(snapshot: RuntimeMobileSessionTabsSnapshot): RuntimeMobileSessionTabsSnapshot {
    let changed = false
    const tabs = snapshot.tabs.map((tab) => {
      if (tab.type !== 'terminal') {
        return tab
      }
      const resolution = this.byTabId.get(tab.parentTabId)
      if (
        !resolution ||
        !runtimeWorktreeIdsEqual(snapshot.worktree, resolution.worktreeId) ||
        tab.launchDraft !== resolution.text ||
        tab.launchDraftCreatedAt !== resolution.createdAt
      ) {
        return tab
      }
      changed = true
      const next = { ...tab }
      delete next.launchDraft
      delete next.launchDraftCreatedAt
      return next
    })
    return changed ? { ...snapshot, tabs } : snapshot
  }

  /** The resolved draft leaves the worktree's rows at the next emit, which `applyFence` shapes. */
  private retireFromMobileSnapshot(resolution: DraftResolutionTombstone): void {
    this.deps.scheduleMobileSnapshot(resolution.worktreeId)
  }
}
