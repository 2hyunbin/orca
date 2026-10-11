import { defaultAgentChatLabel } from '../../../shared/agent-session-chat-label'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { collectSavedStructuredAgentSessionIds } from '../saved-structured-agent-session-restoration'
import { seedStructuredAgentSessionTabIndex } from '../structured-agent-session-tab-index-seed'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type {
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-types'
import { getHeadlessMobileSessionGroupId } from '../mobile-session-layout-projection'
import type { StructuredAgentId } from '../../../shared/agent-session-provider-handle'
import type { StructuredAgentSessionCloseCause } from '../../native-chat/agent-session-wire/structured-agent-session-host-lifetime'
import { retireStructuredAgentSessionTabFrom } from '../structured-agent-session-tab-retirement'
import type { RuntimeStore } from '../runtime-store-contract'

export type RuntimeStructuredSessionTabsHost = {
  prepareStructuredAgentSessionStartupRestoration(): Promise<void>
  getStore(): Pick<RuntimeStore, 'getWorkspaceSession'> | null
  getKnownWorkspaceSessionWorktreeIds(): Iterable<string>
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
    worktreeId?: string,
    options?: { allowAttachedWindow?: boolean; onlyRuntimeOwnedTerminals?: boolean }
  ): Set<string>
  hasPersistedStructuredAgentSessionStore(): boolean
  notifyMobileSessionTabSnapshots(): void
  getMobileSnapshots(): Map<string, RuntimeMobileSessionTabsSnapshot>
  storeMobileSessionSnapshot(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot
  emitMobileSessionTabsSnapshot(snapshot: RuntimeMobileSessionTabsSnapshot): void
  projectStructuredAgentSessionTab: RuntimeStructuredSessionTabs['projectStructuredAgentSessionTab']
  retireStructuredAgentSessionTabFromSnapshot: RuntimeStructuredSessionTabs['retireStructuredAgentSessionTabFromSnapshot']
  restoreStructuredAgentSessionTabsOnce: RuntimeStructuredSessionTabs['restoreStructuredAgentSessionTabsOnce']
}

export class RuntimeStructuredSessionTabs {
  private structuredAgentSessionTabRestorePromise: Promise<void> | null = null
  private structuredAgentSessionInventoryUnverifiable = false

  get inventoryUnverifiable(): boolean {
    return this.structuredAgentSessionInventoryUnverifiable
  }

  constructor(private readonly host: RuntimeStructuredSessionTabsHost) {}

  async restoreStructuredAgentSessionTabsOnce(): Promise<void> {
    await this.host.prepareStructuredAgentSessionStartupRestoration()
    const host = getStructuredAgentSessionHost()
    const persistedVisibleIndex =
      typeof host?.getPersistedVisibleSessionTabIndex === 'function'
        ? host.getPersistedVisibleSessionTabIndex()
        : { present: false, sessionIds: [] }
    const profileIds = collectSavedStructuredAgentSessionIds(
      this.host.getStore()?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID) ?? null
    )
    const targets = persistedVisibleIndex.present ? persistedVisibleIndex.sessionIds : profileIds
    await host?.restoreReadableSessions(targets)
    for (const worktreeId of this.host.getKnownWorkspaceSessionWorktreeIds()) {
      this.host.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true
      })
    }
    this.host.hydrateHeadlessMobileSessionTabsFromWorkspaceSession()
    // Every session here is of an agent this host registered: its store holds no other agent's records.
    const restored = (host?.listSessionTabs() ?? []).flatMap((session) => {
      let sessionId = session.sessionId
      while (sessionId.startsWith('agent-session:')) {
        sessionId = sessionId.slice('agent-session:'.length)
      }
      return [{ ...session, agent: session.agent, sessionId }]
    })
    await seedStructuredAgentSessionTabIndex(
      host,
      targets,
      restored.map((session) => session.sessionId)
    )
    // Past the seed, projecting records nothing.
    for (const session of restored) {
      this.host.projectStructuredAgentSessionTab({ ...session, activate: false, notify: false })
    }
    const wasUnverifiable = this.structuredAgentSessionInventoryUnverifiable
    // No host means no one can say which chats exist; with none on disk, empty is the answer.
    this.structuredAgentSessionInventoryUnverifiable =
      !host && this.host.hasPersistedStructuredAgentSessionStore()
    // This restore published quietly; subscribers still hold the frames that said "cannot tell".
    if (wasUnverifiable && !this.structuredAgentSessionInventoryUnverifiable) {
      this.host.notifyMobileSessionTabSnapshots()
    }
  }

  async publishStructuredAgentSessionTab(input: {
    workspaceId: string
    sessionId: string
    agent: StructuredAgentId
    activate: boolean
    notify?: boolean
    /** The host tab id a create reserved; a session that already has a tab keeps its own. */
    tabId?: string
  }): Promise<void> {
    const host = getStructuredAgentSessionHost()
    if (typeof host?.setSessionTabVisibility === 'function') {
      // The restore index is bookkeeping: one that cannot be written (a newer Orca's records, a
      // failing disk) is reported, and the tab still opens.
      await host
        .setSessionTabVisibility(input.sessionId, true, ...(input.tabId ? [input.tabId] : []))
        .catch((error: unknown) => {
          host.deps.logger.warn('recording an opened chat tab failed', {
            scope: 'tab-visibility-open',
            sessionId: input.sessionId,
            error
          })
        })
    }
    this.host.projectStructuredAgentSessionTab(input)
  }

  projectStructuredAgentSessionTab(input: {
    workspaceId: string
    sessionId: string
    agent: StructuredAgentId
    activate: boolean
    notify?: boolean
  }): void {
    const existing = this.host.getMobileSnapshots().get(input.workspaceId)
    const id = `agent-session:${input.sessionId}`
    if (existing?.tabs.some((tab) => tab.id === id)) {
      // A background re-publish is a no-op — no store write, no emit — so it cannot re-surface a
      // client whose mirror lost the tab; healing one needs `activate` or an explicit republish.
      if (!input.activate) {
        return
      }
      const priorGroups = existing.tabGroups ?? []
      const groupId =
        priorGroups.find((group) => group.tabOrder.includes(id))?.id ??
        (priorGroups.some((group) => group.id === existing.activeGroupId)
          ? existing.activeGroupId
          : priorGroups[0]?.id)
      const snapshot: RuntimeMobileSessionTabsSnapshot = {
        ...existing,
        snapshotVersion: existing.snapshotVersion + 1,
        activeGroupId: groupId ?? existing.activeGroupId,
        activeTabId: id,
        activeTabType: 'agent-session',
        tabGroups: priorGroups.map((group) =>
          group.id === groupId ? { ...group, activeTabId: id } : group
        ),
        tabs: existing.tabs.map((tab) => ({ ...tab, isActive: tab.id === id }))
      }
      const stored = this.host.storeMobileSessionSnapshot(input.workspaceId, snapshot)
      if (input.notify !== false) {
        this.host.emitMobileSessionTabsSnapshot(stored)
      }
      return
    }
    const tab: RuntimeMobileSessionAgentTab = {
      type: 'agent-session',
      id,
      title: defaultAgentChatLabel(input.agent),
      sessionId: input.sessionId,
      agent: input.agent,
      isActive: input.activate
    }
    const tabs = [...(existing?.tabs ?? [])].map((candidate) => ({
      ...candidate,
      isActive: input.activate ? false : candidate.isActive
    }))
    tabs.push(tab)
    const priorGroups = existing?.tabGroups ?? [
      {
        id: getHeadlessMobileSessionGroupId(input.workspaceId),
        activeTabId: existing?.activeTabId ?? null,
        tabOrder: []
      }
    ]
    const groupId = priorGroups.some((group) => group.id === existing?.activeGroupId)
      ? existing!.activeGroupId!
      : priorGroups[0]!.id
    const tabGroups = priorGroups.map((group) =>
      group.id === groupId
        ? {
            ...group,
            activeTabId: input.activate ? id : group.activeTabId,
            tabOrder: [...group.tabOrder, id]
          }
        : group
    )
    const snapshot: RuntimeMobileSessionTabsSnapshot = {
      worktree: input.workspaceId,
      publicationEpoch: existing?.publicationEpoch ?? `structured:${Date.now().toString(36)}`,
      snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
      activeGroupId: input.activate ? groupId : (existing?.activeGroupId ?? groupId),
      activeTabId: input.activate ? id : (existing?.activeTabId ?? null),
      activeTabType: input.activate ? 'agent-session' : (existing?.activeTabType ?? null),
      tabGroups,
      ...(existing?.tabGroupLayout ? { tabGroupLayout: existing.tabGroupLayout } : {}),
      tabs
    }
    const stored = this.host.storeMobileSessionSnapshot(input.workspaceId, snapshot)
    if (input.notify !== false) {
      this.host.emitMobileSessionTabsSnapshot(stored)
    }
  }

  async closeStructuredAgentSessionTab(
    tab: RuntimeMobileSessionAgentTab,
    cause: StructuredAgentSessionCloseCause
  ): Promise<void> {
    const host = getStructuredAgentSessionHost()
    if (host) {
      if (typeof host.setSessionTabVisibility === 'function') {
        // The restore index is bookkeeping: one that cannot be written (a newer Orca's records, a
        // failing disk) is reported, and the tab still closes.
        await host.setSessionTabVisibility(tab.sessionId, false).catch((error: unknown) => {
          host.deps.logger.warn('recording a closed chat tab failed', {
            scope: 'tab-visibility-close',
            sessionId: tab.sessionId,
            error
          })
        })
      }
    }
    // Retire durable visibility and the runtime snapshot before stopping the provider.
    this.host.retireStructuredAgentSessionTabFromSnapshot(tab.sessionId)
    if (typeof host?.close === 'function') {
      await host.close(tab.sessionId, cause)
    }
  }

  retireStructuredAgentSessionTabFromSnapshot(sessionId: string): boolean {
    for (const [worktreeId, snapshot] of this.host.getMobileSnapshots()) {
      const nextSnapshot = retireStructuredAgentSessionTabFrom(snapshot, sessionId)
      if (!nextSnapshot) {
        continue
      }
      this.host.storeMobileSessionSnapshot(worktreeId, nextSnapshot)
      this.host.emitMobileSessionTabsSnapshot(nextSnapshot)
      return true
    }
    return false
  }

  restoreStructuredAgentSessionTabs(): Promise<void> {
    this.structuredAgentSessionTabRestorePromise ??= this.host
      .restoreStructuredAgentSessionTabsOnce()
      .then(
        () => {
          // Only a host's answer is final: without one, the next caller restores again, so a journal
          // that opens later republishes the chats.
          if (this.structuredAgentSessionInventoryUnverifiable) {
            this.structuredAgentSessionTabRestorePromise = null
          }
        },
        (error) => {
          this.structuredAgentSessionTabRestorePromise = null
          throw error
        }
      )
    return this.structuredAgentSessionTabRestorePromise
  }
}
