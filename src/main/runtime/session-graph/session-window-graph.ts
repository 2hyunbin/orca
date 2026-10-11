import type { RuntimeSessionTabsInventory } from '../session-tabs/session-tabs-inventory'
import { prepareSessionGraphPublication } from './session-graph-publication'
import type { CollectMobileVisibleGraphChangedWorktrees } from './mobile-visible-graph-changes'
import type {
  RuntimeRendererSyncWindowGraph,
  RuntimeSyncedLeaf,
  RuntimeSyncWindowGraph,
  RuntimeSyncWindowGraphResult,
  RuntimeStatus,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-types'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-types'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'
import type { RuntimeGraphState } from './session-graph-state'
import type { RuntimeSessionGraphLifecycle } from './session-graph-lifecycle'
import type { RuntimeMobileSessionReconciliation } from '../session-tabs/mobile-session-reconciliation'
import type { SessionTabsInventoryPublication } from '../session-tabs/session-tabs-inventory-publication'
import type { PtyIncarnationHandleRecord } from '../orca-runtime-core'
import type { PtyLivenessVerdict } from '../../../shared/pty-liveness-verdict'
import type { RuntimeAgentOrchestrationProjection } from '../runtime-agent-orchestration-projection'
import type { RuntimeNativeChatDraftResolutions } from '../runtime-native-chat-draft-resolutions'

export type RuntimeSessionWindowGraphHost = {
  attachWindow(windowId: number): void
  state: RuntimeGraphState
  publication: SessionTabsInventoryPublication
  reconcileMobileSessionRetirementFences(leaves: readonly RuntimeSyncedLeaf[]): RuntimeSyncedLeaf[]
  nextTitleObservationSequence(): number
  markPtyColdParked(ptyId: string): void
  clearPtyColdParked(ptyId: string): void
  getLeafKey(tabId: string, leafId: string): string
  getPty(ptyId: string): RuntimePtyWorktreeRecord | undefined
  getPtyLivenessVerdict(ptyId: string): PtyLivenessVerdict | null
  recordPtyWorktree(
    ptyId: string,
    worktreeId: string,
    state: Partial<
      Pick<
        RuntimePtyWorktreeRecord,
        | 'connected'
        | 'lastOutputAt'
        | 'preview'
        | 'tabId'
        | 'paneKey'
        | 'surfaceRecordedAtGraphSequence'
      >
    >
  ): RuntimePtyWorktreeRecord
  makeRuntimePaneKey(leaf: RuntimeSyncedLeaf): string
  adoptFirstPtyForLeafHandle(leafKey: string, ptyId: string | null, generation: number): boolean
  invalidateLeafHandle(leafKey: string): void
  handleByPtyIncarnation(): ReadonlyMap<string, PtyIncarnationHandleRecord>
  handleByPtyId(): ReadonlyMap<string, string>
  handleByLeafKey(): Map<string, string>
  rebuildLeafPtyIndex(): void
  reconcilePtyIncarnationHandles(): void
  snapshots(): Map<string, RuntimeMobileSessionTabsSnapshot>
  storeMobileSessionSnapshot(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot
  scheduleMobileSessionTabsChanged(worktreeId: string): void
  adoptPreAllocatedHandle(leaf: RuntimeLeafRecord): void
  hasOrchestrationDb(): boolean
  checkDeliverySettledAndArmRecheck(leaf: RuntimeLeafRecord): boolean
  deliverPendingMessagesForLeaf(leaf: RuntimeLeafRecord): void
  agentOrchestration(): Pick<RuntimeAgentOrchestrationProjection, 'buildByPaneKey'>
  getStatus(): RuntimeStatus
  syncMobileSessionTabs: RuntimeMobileSessionReconciliation['syncMobileSessionTabs']
  collectMobileVisibleGraphChangedWorktrees: CollectMobileVisibleGraphChangedWorktrees
  markGraphReady: RuntimeSessionGraphLifecycle['markGraphReady']
  markSessionTabsInventoryPublished: RuntimeSessionTabsInventory['markSessionTabsInventoryPublished']
  getNativeChatLaunchDraftResolutionClientEventSnapshot: RuntimeNativeChatDraftResolutions['snapshot']
}

export class RuntimeSessionWindowGraph {
  constructor(private readonly host: RuntimeSessionWindowGraphHost) {}

  shouldRelayTerminalBrowserOpens(): boolean {
    return this.host.state.authoritativeWindowId === HEADLESS_RUNTIME_WINDOW_ID
  }

  syncWindowGraph(
    windowId: number,
    graph: RuntimeSyncWindowGraph | RuntimeRendererSyncWindowGraph
  ): RuntimeSyncWindowGraphResult {
    // `tabs` and several downstream indexes are keyed only by tab id. Reject
    // malformed persisted/mirrored graphs before authority or graph state is
    // changed; choosing a winner would route PTYs to the wrong worktree.
    const rendererGeneration = prepareSessionGraphPublication(this.host, windowId, graph)
    const graphWasReady = this.host.state.graphStatus === 'ready'
    const previousTabs = this.host.state.tabs
    const previousLeaves = this.host.state.leaves
    this.host.state.tabs = new Map(graph.tabs.map((tab) => [tab.tabId, tab]))
    const lifecycleLeaves = this.host.reconcileMobileSessionRetirementFences(graph.leaves)
    const mobileSessionResyncWorktrees = new Set<string>()
    const changedMobileWorktrees = this.host.syncMobileSessionTabs(
      graph.mobileSessionTabs,
      graph.unchangedMobileSessionWorktrees,
      mobileSessionResyncWorktrees,
      rendererGeneration
    )
    const nextLeaves = new Map<string, RuntimeLeafRecord>()
    const graphSyncedAt = this.host.nextTitleObservationSequence()
    // Bumped before the leaf loop so surfaces this statement records are stamped with it, and a
    // surface recorded after it is immune until the next one (pty-recorded-surface-topology.ts).
    // The headless placeholder is exempt: it is published once at launch so status clients see a
    // ready server, names no renderer pane, and is never replaced. Counting it as a statement left
    // every claim written without standing — a persisted replay, an inventory restore, a TUI-owner
    // recovery — permanently orphaned on a headless host, with no graph that could ever re-stamp
    // it (#18191).
    if (windowId !== HEADLESS_RUNTIME_WINDOW_ID) {
      this.host.state.graphSequence += 1
    }

    // Why: renderer reloads can briefly republish the same leaf with no ptyId;
    // keep live CLI handles usable while the UI graph rebuilds.
    const preserveLivePtysDuringReload = this.host.state.graphStatus === 'reloading'
    for (const leaf of lifecycleLeaves) {
      if (leaf.ptyId) {
        if (leaf.parked) {
          this.host.markPtyColdParked(leaf.ptyId)
        } else {
          this.host.clearPtyColdParked(leaf.ptyId)
        }
      }
      const leafKey = this.host.getLeafKey(leaf.tabId, leaf.leafId)
      const existing = this.host.state.leaves.get(leafKey)
      const ptyId =
        preserveLivePtysDuringReload && leaf.ptyId === null && existing?.ptyId
          ? existing.ptyId
          : leaf.ptyId
      const ptyGeneration =
        existing && existing.ptyId !== ptyId
          ? existing.ptyGeneration + 1
          : (existing?.ptyGeneration ?? 0)
      const existingPty = ptyId ? this.host.getPty(ptyId) : undefined
      // Retained history stays addressable, but a renderer graph cannot revoke a host-certified exit.
      const connected =
        ptyId !== null && this.host.getPtyLivenessVerdict(ptyId)?.status !== 'exited'
      const tailSource = existing?.ptyId === ptyId ? existing : existingPty

      nextLeaves.set(leafKey, {
        ...leaf,
        ptyId,
        ptyGeneration,
        connected,
        writable: this.host.state.graphStatus === 'ready' && connected,
        lastOutputAt: tailSource?.lastOutputAt ?? null,
        lastExitCode: tailSource?.lastExitCode ?? null,
        lastExitCause: tailSource?.lastExitCause ?? null,
        tailBuffer: tailSource?.tailBuffer ?? [],
        tailTranscriptBuffer: tailSource?.tailTranscriptBuffer ?? [],
        tailTranscriptChars: tailSource?.tailTranscriptChars ?? 0,
        tailPartialLine: tailSource?.tailPartialLine ?? '',
        tailPendingAnsi: tailSource?.tailPendingAnsi ?? '',
        tailRedrawCursor: tailSource?.tailRedrawCursor ?? null,
        tailTruncated: tailSource?.tailTruncated ?? false,
        tailLinesTotal: tailSource?.tailLinesTotal ?? 0,
        preview: tailSource?.preview ?? '',
        waitBlockedAt: tailSource?.waitBlockedAt ?? null,
        lastAgentStatus: tailSource?.lastAgentStatus ?? null,
        lastAgentStatusObservedLive: tailSource?.lastAgentStatusObservedLive ?? false,
        lastOscTitle: tailSource?.lastOscTitle ?? null,
        lastOscTitleAt: tailSource?.lastOscTitleAt ?? null,
        paneTitleUpdatedAt:
          existing?.ptyId === ptyId && existing.paneTitle === leaf.paneTitle
            ? existing.paneTitleUpdatedAt
            : graphSyncedAt
      })

      if (leaf.ptyId && connected) {
        this.host.recordPtyWorktree(leaf.ptyId, leaf.worktreeId, {
          connected: true,
          lastOutputAt: existing?.ptyId === leaf.ptyId ? existing.lastOutputAt : null,
          preview: existing?.ptyId === leaf.ptyId ? existing.preview : '',
          tabId: leaf.tabId,
          paneKey: this.host.makeRuntimePaneKey(leaf),
          surfaceRecordedAtGraphSequence: this.host.state.graphSequence
        })
      }

      if (existing && (existing.ptyId !== ptyId || existing.ptyGeneration !== ptyGeneration)) {
        // Why: mobile can subscribe while the pane is waiting for its first PTY.
        // Keep that handle usable after the recovery mount binds it.
        const adoptedFirstPty =
          existing.ptyId === null &&
          this.host.adoptFirstPtyForLeafHandle(leafKey, ptyId, ptyGeneration)
        if (!adoptedFirstPty) {
          this.host.invalidateLeafHandle(leafKey)
        }
      }
    }

    // Why: computed BEFORE preserving stale leaves so preservation can refuse a
    // leaf whose PTY the incoming graph already rebound to a live leaf. Two
    // leaves on one PTY resolve to the same handle (handles are ptyId-keyed) and
    // crash paired clients with a duplicate React key.
    const nextPtyIds = new Set(
      [...nextLeaves.values()].map((leaf) => leaf.ptyId).filter((ptyId): ptyId is string => !!ptyId)
    )
    for (const oldLeafKey of this.host.state.leaves.keys()) {
      if (!nextLeaves.has(oldLeafKey)) {
        const oldLeaf = this.host.state.leaves.get(oldLeafKey)
        if (oldLeaf?.ptyId && !nextPtyIds.has(oldLeaf.ptyId)) {
          // A cold-parked PTY remains alive without a graph leaf; hold its
          // staged Enter until a live idle frame authorizes submission.
          this.host.markPtyColdParked(oldLeaf.ptyId)
        }
        const retainedIncarnation = oldLeaf?.ptyId
          ? this.host.handleByPtyIncarnation().get(oldLeaf.ptyId)
          : undefined
        if (
          preserveLivePtysDuringReload &&
          oldLeaf?.ptyId &&
          (this.host.handleByPtyId().has(oldLeaf.ptyId) ||
            (retainedIncarnation &&
              retainedIncarnation.incarnationId ===
                this.host.getPty(oldLeaf.ptyId)?.incarnationId)) &&
          !nextPtyIds.has(oldLeaf.ptyId)
        ) {
          // Why: a CLI-created agent keeps using its exported handle even if
          // the reloaded renderer has not rebound the pane yet.
          nextLeaves.set(oldLeafKey, oldLeaf)
          nextPtyIds.add(oldLeaf.ptyId)
        } else if (oldLeaf?.ptyId && nextPtyIds.has(oldLeaf.ptyId)) {
          // Why: the incoming graph already rebound this PTY to a live leaf (e.g.
          // a woken agent re-keyed to a new leaf during renderer reload). Keeping
          // the old leaf too would put two leaves on ONE PTY, which emit the same
          // terminal handle and crash paired clients. Drop the stale leaf; if its
          // handle is the shared ptyId-keyed one it belongs to the live leaf now,
          // so release only this dead leaf key's alias. A leaf-unique handle has
          // no next owner — invalidate it so in-flight CLI waiters fail fast
          // instead of hanging on a dead leaf.
          const oldHandle = this.host.handleByLeafKey().get(oldLeafKey)
          const incarnationHandle = retainedIncarnation?.handle
          if (
            oldHandle !== undefined &&
            (oldHandle === this.host.handleByPtyId().get(oldLeaf.ptyId) ||
              oldHandle === incarnationHandle)
          ) {
            this.host.handleByLeafKey().delete(oldLeafKey)
          } else {
            this.host.invalidateLeafHandle(oldLeafKey)
          }
        } else {
          this.host.invalidateLeafHandle(oldLeafKey)
        }
      }
    }

    for (const [ptyId, leaf] of this.host.state.detachedPreAllocatedLeaves) {
      if (nextPtyIds.has(ptyId) || !this.host.handleByPtyId().has(ptyId)) {
        this.host.state.detachedPreAllocatedLeaves.delete(ptyId)
        continue
      }
      nextLeaves.set(this.host.getLeafKey(leaf.tabId, leaf.leafId), leaf)
      nextPtyIds.add(ptyId)
    }

    this.host.state.leaves = nextLeaves
    this.host.rebuildLeafPtyIndex()
    this.host.reconcilePtyIncarnationHandles()
    // Why: the emitted client payload is a function of the stored snapshot AND
    // the tab/leaf graph (handles/titles/connected resolve from leaf state), so
    // a graph-only change — e.g. a restored leaf binding its ptyId while the
    // snapshot pair is unchanged — must also fan out, or a paired client stays
    // on pending-handle forever. Schedule the union on the same 50ms trailing
    // edge as the OSC-title path; the coalescer emit reads the latest state at
    // fire time so no final version is ever lost.
    for (const worktreeId of this.host.collectMobileVisibleGraphChangedWorktrees(
      previousTabs,
      previousLeaves
    )) {
      if (changedMobileWorktrees.has(worktreeId)) {
        continue
      }
      const stored = this.host.snapshots().get(worktreeId)
      if (!stored) {
        continue
      }
      // Why: web clients drop same-epoch frames whose version isn't strictly
      // newer, so a graph-only change must mint a fresh stored version (like
      // the PTY touch path does) or the re-emitted payload — e.g. the
      // pending-handle → ready flip — is discarded and the client stays stale.
      // The accepted-renderer tracking is untouched: this is a main-local bump.
      this.host.storeMobileSessionSnapshot(worktreeId, {
        ...stored,
        snapshotVersion: stored.snapshotVersion + 1
      })
      changedMobileWorktrees.add(worktreeId)
    }
    for (const worktreeId of changedMobileWorktrees) {
      if (this.host.snapshots().has(worktreeId)) {
        this.host.scheduleMobileSessionTabsChanged(worktreeId)
      }
    }
    const isAuthoritativeGraphPublisher = windowId === this.host.state.authoritativeWindowId
    this.host.markGraphReady(windowId)
    if (
      isAuthoritativeGraphPublisher &&
      (windowId === HEADLESS_RUNTIME_WINDOW_ID || graph.mobileSessionTabs !== undefined)
    ) {
      if (mobileSessionResyncWorktrees.size === 0) {
        this.host.markSessionTabsInventoryPublished()
      } else {
        this.host.publication.reset()
      }
    }
    if (rendererGeneration !== undefined) {
      this.host.state.rendererGeneration = rendererGeneration
    }
    for (const leaf of this.host.state.leaves.values()) {
      this.host.adoptPreAllocatedHandle(leaf)
      const previousLeaf = previousLeaves.get(this.host.getLeafKey(leaf.tabId, leaf.leafId))
      if (
        this.host.hasOrchestrationDb() &&
        leaf.lastAgentStatus === 'idle' &&
        leaf.lastAgentStatusObservedLive &&
        this.host.checkDeliverySettledAndArmRecheck(leaf) &&
        leaf.writable &&
        (!graphWasReady ||
          previousLeaf?.ptyId !== leaf.ptyId ||
          !previousLeaf.writable ||
          previousLeaf.lastAgentStatus !== 'idle' ||
          !previousLeaf.lastAgentStatusObservedLive)
      ) {
        this.host.deliverPendingMessagesForLeaf(leaf)
      }
    }

    // Why: createTerminal waits for the renderer's graph sync to populate the
    // new leaf so it can return a handle. Drain callbacks after leaves update.
    for (const cb of Array.from(this.host.state.graphSyncCallbacks)) {
      cb()
    }

    const agentOrchestrationByPaneKey = this.host.agentOrchestration().buildByPaneKey()
    const nativeChatLaunchDraftResolutions = this.host
      .getNativeChatLaunchDraftResolutionClientEventSnapshot()
      .map(({ tabId, text, createdAt }) => ({ tabId, text, createdAt }))
    return {
      ...this.host.getStatus(),
      ...(agentOrchestrationByPaneKey ? { agentOrchestrationByPaneKey } : {}),
      ...(nativeChatLaunchDraftResolutions.length > 0 ? { nativeChatLaunchDraftResolutions } : {}),
      ...(mobileSessionResyncWorktrees.size > 0
        ? { mobileSessionResyncWorktrees: [...mobileSessionResyncWorktrees] }
        : {})
    }
  }
}
