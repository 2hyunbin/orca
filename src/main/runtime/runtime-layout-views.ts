// The per-view store (design §1.4): each view's own record, the drafts its editors hold, the content
// facts it reports and the navigation requests addressed to it. The runtime is the only writer of
// per-view fields in every partition (O1). `desktop`'s record is stored in each partition's
// selection fields, so a downgraded build restores it; a paired device's in its selection record.

import { isDeepStrictEqual } from 'node:util'
import type { BrowserPage } from '../../shared/browser-workspace-types'
import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { PersistedMobileClientTabSelections } from '../../shared/persisted-state-types'
import type { RuntimeMobileTerminalTheme } from '../../shared/runtime-mobile-session-tab-contracts'
import {
  VIEW_SESSION_FIELDS,
  type BrowserTabLiveState
} from '../../shared/workspace-layout/workspace-layout-beside'
import { pickStoredFields } from '../../shared/workspace-layout/stored-record-fields'
import {
  deviceSelectionsFromView,
  deviceViewFromSelections
} from '../../shared/workspace-layout/workspace-layout-device-view'
import type { LayoutNavigateRequest } from '../../shared/workspace-layout/workspace-layout-stream-frames'
import {
  desktopViewForPartition,
  mergeDesktopViewParts,
  type ViewRecordOwners
} from '../../shared/workspace-layout/workspace-layout-view-partitions'
import {
  DESKTOP_VIEW_ID,
  type LayoutViewId,
  type LayoutViewRecord
} from '../../shared/workspace-layout/workspace-layout-views'
import type { RuntimeWorkspaceLayouts } from './runtime-workspace-layouts'
import { holderStoreOf, writeUnheldViewFields } from './runtime-workspace-layout-writer'
import type { RuntimeStore } from './runtime-store-contract'

/** What a view reports for phones to show; kept in memory only. */
export type LayoutViewContentFacts = {
  terminalTheme?: RuntimeMobileTerminalTheme
  /** Terminal tab id → the text a launch left in its composer. */
  launchDrafts?: Record<string, { text: string; createdAt: number }>
}

type ViewStore = Parameters<typeof holderStoreOf>[0] &
  Pick<RuntimeStore, 'getMobileClientTabSelections' | 'setMobileClientTabSelections'>

type NavigateListener = (request: LayoutNavigateRequest) => void

export class RuntimeLayoutViews {
  private readonly navigateListeners = new Map<LayoutViewId, Set<NavigateListener>>()
  /** Workspace key → editor tab ids whose view holds an unsaved draft. */
  private readonly draftTabs = new Map<string, Set<string>>()
  private readonly contentFactsByView = new Map<LayoutViewId, LayoutViewContentFacts>()

  constructor(
    private readonly holder: RuntimeWorkspaceLayouts,
    private readonly runtimeStore: () => ViewStore | null
  ) {}

  record(viewId: LayoutViewId): LayoutViewRecord {
    if (viewId !== DESKTOP_VIEW_ID) {
      return deviceViewFromSelections(this.deviceSelections()[deviceIdOf(viewId)] ?? {})
    }
    const parts = new Map<ExecutionHostId, Partial<LayoutViewRecord>>()
    for (const hostId of this.holder.loadedHostIds()) {
      const view = this.holder.beside(hostId)?.desktopView
      if (view) {
        parts.set(hostId, view)
      }
    }
    const store = this.store()
    for (const hostId of store ? this.serverPartitions() : []) {
      parts.set(hostId, pickStoredFields(store!.getWorkspaceSession(hostId), VIEW_SESSION_FIELDS))
    }
    return mergeDesktopViewParts(parts)
  }

  /** The view's whole record; only the partitions whose part changed are saved. */
  setRecord(viewId: LayoutViewId, record: LayoutViewRecord): void {
    if (viewId !== DESKTOP_VIEW_ID) {
      this.runtimeStore()?.setMobileClientTabSelections?.({
        ...this.deviceSelections(),
        [deviceIdOf(viewId)]: deviceSelectionsFromView(record)
      })
      return
    }
    const owners: ViewRecordOwners = {
      workspace: (key) => this.holder.hostIdOf(key),
      terminalTab: (tabId) => this.holder.findTerminalTab(tabId)?.hostId ?? null
    }
    for (const hostId of this.holder.loadedHostIds()) {
      const part = desktopViewForPartition(record, hostId, owners)
      if (!isDeepStrictEqual(part, this.holder.beside(hostId)?.desktopView)) {
        this.holder.updateBeside(hostId, { desktopView: part })
      }
    }
    const store = this.store()
    if (!store) {
      return
    }
    for (const hostId of this.serverPartitions()) {
      writeUnheldViewFields(store, hostId, desktopViewForPartition(record, hostId, owners))
    }
  }

  /** Navigation requests for this view, until the returned unsubscribe. */
  onNavigate(viewId: LayoutViewId, listener: NavigateListener): () => void {
    let listeners = this.navigateListeners.get(viewId)
    if (!listeners) {
      listeners = new Set()
      this.navigateListeners.set(viewId, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.navigateListeners.delete(viewId)
      }
    }
  }

  /** A view not subscribed now does not get it later: navigation is a request, not state. */
  navigate(viewId: LayoutViewId, request: LayoutNavigateRequest): void {
    for (const listener of this.navigateListeners.get(viewId) ?? []) {
      listener(request)
    }
  }

  setDraftState(workspace: string, tabId: string, dirty: boolean): void {
    const tabs = this.draftTabs.get(workspace) ?? new Set<string>()
    if (dirty) {
      tabs.add(tabId)
      this.draftTabs.set(workspace, tabs)
    } else if (tabs.delete(tabId) && tabs.size === 0) {
      this.draftTabs.delete(workspace)
    }
  }

  /** Editor tabs with an unsaved draft: a close refuses them unless forced (rule 10). */
  draftTabIds(workspace: string): string[] {
    return [...(this.draftTabs.get(workspace) ?? [])]
  }

  /** A closed tab's draft went with it; a reopened tab starts clean. */
  forgetDrafts(workspace: string, tabIds: readonly string[]): void {
    for (const tabId of tabIds) {
      this.setDraftState(workspace, tabId, false)
    }
  }

  /** The view's serialized screen of a pane it parks or quits with, saved as today's scrollback. */
  setScrollback(paneKey: string, serialized: string): void {
    const pane = parsePaneKey(paneKey)
    const hostId = pane ? this.holder.findTerminalTab(pane.tabId)?.hostId : undefined
    const facts = hostId ? this.holder.beside(hostId)?.facts : undefined
    if (!pane || !hostId || !facts) {
      return
    }
    const scrollback = { ...facts.scrollback[pane.leafId], buffer: serialized }
    this.holder.updateBeside(hostId, {
      facts: { ...facts, scrollback: { ...facts.scrollback, [pane.leafId]: scrollback } }
    })
  }

  /** A browser tab's live state and pages as its page host reports them, kept for restore. */
  setPageState(
    workspace: string,
    browserTabId: string,
    tab: BrowserTabLiveState,
    pages: BrowserPage[]
  ): void {
    const hostId = this.holder.hostIdOf(workspace)
    const facts = hostId ? this.holder.beside(hostId)?.facts : undefined
    if (!hostId || !facts) {
      return
    }
    this.holder.updateBeside(hostId, {
      facts: {
        ...facts,
        browserTabs: {
          ...facts.browserTabs,
          [workspace]: { ...facts.browserTabs[workspace], [browserTabId]: tab }
        },
        browserPagesByWorkspace: { ...facts.browserPagesByWorkspace, [browserTabId]: pages }
      }
    })
  }

  setContentFacts(viewId: LayoutViewId, facts: LayoutViewContentFacts): void {
    this.contentFactsByView.set(viewId, { ...this.contentFactsByView.get(viewId), ...facts })
  }

  contentFacts(viewId: LayoutViewId): LayoutViewContentFacts {
    return this.contentFactsByView.get(viewId) ?? {}
  }

  private store() {
    return holderStoreOf(this.runtimeStore())
  }

  private deviceSelections(): PersistedMobileClientTabSelections {
    return this.runtimeStore()?.getMobileClientTabSelections?.() ?? {}
  }

  /** `runtime:<env>` partitions: the holder carries none of their layout, only these fields. */
  private serverPartitions(): ExecutionHostId[] {
    return (this.store()?.getWorkspaceSessionHostIds() ?? []).filter(
      (hostId) => parseExecutionHostId(hostId)?.kind === 'runtime'
    )
  }
}

function deviceIdOf(viewId: LayoutViewId): string {
  return viewId.slice('device:'.length)
}
