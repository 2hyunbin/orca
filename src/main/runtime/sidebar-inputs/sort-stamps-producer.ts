import { resolveAgentStatusWorktreeId } from '../../../shared/agent-status-worktree-attribution'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import {
  classifySortStampEvent,
  hookRowAgentPhase,
  nextAgentPaneState,
  REST_PANE,
  titleAgentPhase,
  type AgentPaneState,
  type AgentPhase,
  type SmartStampFields,
  type SmartTier,
  type SortStampEvent,
  type SortStamps
} from '../../../shared/sidebar-list/sort-stamps'
import type { TerminalSideEffectBatch } from '../../../shared/terminal-side-effect-facts'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { AgentStatusStoreView } from './workspace-activity-facts-producer'

type StampedRecord = { lastActivityAt: number } & SmartStampFields
type StampUpdates = {
  lastActivityAt: number
  smartTier: SmartTier | undefined
  smartAt: number | undefined
}

/** The record reads and writes stamping needs, which the runtime's store satisfies. */
export type SortStampsStore = {
  getWorktreeMeta: (worktreeId: string) => StampedRecord | undefined
  setWorktreeMeta: (worktreeId: string, updates: StampUpdates) => unknown
  getFolderWorkspace?: (folderWorkspaceId: string) => StampedRecord | undefined
  updateFolderWorkspace?: (folderWorkspaceId: string, updates: StampUpdates) => unknown
}

export type SortStampsSources = {
  store: () => SortStampsStore | null
  resolveTabWorktreeId: (tabId: string) => string | undefined
  subscribeToPtyExit: (ptyId: string, listener: () => void) => () => void
  /** Consumes terminal side effects, so the host scans its own bytes for bells and titles. */
  onClientEvent: (
    listener: (event: RuntimeClientEvent) => void,
    options: { consumesTerminalSideEffects: true }
  ) => () => void
  now: () => number
}

type TrackedPane = { worktreeId: string; state: AgentPaneState }

/**
 * Writes the sort stamps of every workspace this host owns, at the source: hook-store transitions
 * (terminal agents and structured chats), hookless agents' titles, bells, and terminals a CLI
 * starts. Creation stamps itself where the record is made. Rest panes are not kept.
 */
export class SortStampsProducer {
  private readonly panes = new Map<string, TrackedPane>()
  /** Title panes seen since their PTY started, by exit subscription: the first title seeds. */
  private readonly titlePaneExits = new Map<string, () => void>()
  private agentStore: AgentStatusStoreView | null = null

  constructor(private readonly sources: SortStampsSources) {
    sources.onClientEvent(
      (event) => {
        if (event.type === 'terminalSideEffects') {
          this.noteTerminalSideEffects(event.batch)
        }
      },
      { consumesTerminalSideEffects: true }
    )
  }

  attachAgentStatusStore(store: AgentStatusStoreView): () => void {
    this.agentStore = store
    // A status present at attach was restored or predates this process: seeded, never stamped.
    for (const row of store.getStatusSnapshot()) {
      this.observeHookPane(row.paneKey, true)
    }
    const unsubscribe = store.subscribeStatusRowMutations(({ before, after }) => {
      for (const paneKey of new Set([before?.paneKey, after?.paneKey])) {
        if (paneKey) {
          this.observeHookPane(paneKey, false)
        }
      }
    })
    return () => {
      unsubscribe()
      this.agentStore = null
    }
  }

  /** A terminal started by something other than a person opening it. */
  noteTerminalStarted(worktreeId: string): void {
    this.stamp(worktreeId, { kind: 'terminal-started' })
  }

  private observeHookPane(paneKey: string, seed: boolean): void {
    // The window applies a pane's rows in arrival order, so the newest is the one it holds.
    let latest: AgentStatusIpcPayload | null = null
    for (const row of this.agentStore?.getStatusSnapshotForPane(paneKey) ?? []) {
      if (!row.providerSessionOnly && (!latest || row.receivedAt > latest.receivedAt)) {
        latest = row
      }
    }
    if (!latest) {
      this.move(paneKey, null, 'rest')
      return
    }
    const worktreeId =
      resolveAgentStatusWorktreeId(latest, { get: this.sources.resolveTabWorktreeId }) ?? null
    const phase = hookRowAgentPhase(latest)
    if (seed || latest.restoredUnconfirmed || latest.isReplay) {
      this.seed(paneKey, worktreeId, { phase, at: latest.stateStartedAt })
      return
    }
    this.move(paneKey, worktreeId, phase)
  }

  private noteTerminalSideEffects(batch: TerminalSideEffectBatch): void {
    const { worktreeId, paneKey } = batch
    // A replay re-sends facts already seen.
    if (batch.replay || !worktreeId) {
      return
    }
    for (const fact of batch.facts) {
      if (fact.kind === 'bell') {
        this.stamp(worktreeId, { kind: 'bell' })
      } else if (fact.kind === 'title' && paneKey && !this.hasHookRows(paneKey)) {
        // A cleared stale working title is a timer's guess, not a finish.
        const phase = fact.staleWorkingTitleClear ? 'rest' : titleAgentPhase(fact.rawTitle)
        this.observeTitlePane(batch.ptyId, paneKey, worktreeId, phase)
      }
    }
  }

  private observeTitlePane(
    ptyId: string,
    paneKey: string,
    worktreeId: string,
    phase: AgentPhase
  ): void {
    if (this.titlePaneExits.has(paneKey)) {
      this.move(paneKey, worktreeId, phase)
      return
    }
    // The agent leaves with its terminal; a later PTY in this pane starts unseen.
    let exited = false
    const release = this.sources.subscribeToPtyExit(ptyId, () => {
      exited = true
      this.titlePaneExits.delete(paneKey)
      this.move(paneKey, null, 'rest')
    })
    if (exited) {
      return
    }
    this.titlePaneExits.set(paneKey, release)
    this.seed(paneKey, worktreeId, { phase, at: this.sources.now() })
  }

  // Hook authority is per pane, as in Smart's attention: a pane with rows ignores its title.
  private hasHookRows(paneKey: string): boolean {
    return (this.agentStore?.getStatusSnapshotForPane(paneKey).length ?? 0) > 0
  }

  private seed(paneKey: string, worktreeId: string | null, state: AgentPaneState): void {
    const previous = this.panes.get(paneKey)
    if (previous && previous.worktreeId !== worktreeId) {
      this.move(paneKey, null, 'rest')
    }
    if (worktreeId && state.phase !== 'rest') {
      this.panes.set(paneKey, { worktreeId, state })
    } else {
      this.panes.delete(paneKey)
    }
  }

  /** One pane observed in `observed`; a pane that left or changed workspace rests where it was. */
  private move(paneKey: string, worktreeId: string | null, observed: AgentPhase): void {
    const previous = this.panes.get(paneKey)
    if (previous && previous.worktreeId !== worktreeId) {
      this.panes.delete(paneKey)
      this.writeAgentChange(previous.worktreeId, previous.state.phase, 'rest')
    }
    if (!worktreeId) {
      return
    }
    const before = previous?.worktreeId === worktreeId ? previous.state : REST_PANE
    const state = nextAgentPaneState(before, observed, this.sources.now())
    if (state === before) {
      return
    }
    if (state.phase === 'rest') {
      this.panes.delete(paneKey)
    } else {
      this.panes.set(paneKey, { worktreeId, state })
    }
    this.writeAgentChange(worktreeId, before.phase, state.phase)
  }

  private writeAgentChange(worktreeId: string, from: AgentPhase, to: AgentPhase): void {
    const panes: AgentPaneState[] = []
    for (const pane of this.panes.values()) {
      if (pane.worktreeId === worktreeId) {
        panes.push(pane.state)
      }
    }
    this.stamp(worktreeId, { kind: 'agent', from, to, panes })
  }

  private stamp(worktreeId: string, event: SortStampEvent): void {
    const current = this.readStamps(worktreeId)
    const next = current && classifySortStampEvent(current, event, this.sources.now())
    if (next) {
      this.writeStamps(worktreeId, next)
    }
  }

  // Only a workspace with a record is stamped; writing would create one for a stale id.
  private readStamps(worktreeId: string): SortStamps | null {
    const store = this.sources.store()
    const scope = parseWorkspaceKey(worktreeId)
    const record =
      scope?.type === 'folder'
        ? store?.getFolderWorkspace?.(scope.folderWorkspaceId)
        : store?.getWorktreeMeta(worktreeId)
    if (!record) {
      return null
    }
    return {
      recentAt: record.lastActivityAt,
      ...(record.smartTier !== undefined
        ? { smartTier: record.smartTier, smartAt: record.smartAt }
        : {})
    }
  }

  private writeStamps(worktreeId: string, stamps: SortStamps): void {
    // Both tier keys are always written, so Rest clears them.
    const updates: StampUpdates = {
      lastActivityAt: stamps.recentAt,
      smartTier: stamps.smartTier,
      smartAt: stamps.smartAt
    }
    const store = this.sources.store()
    const scope = parseWorkspaceKey(worktreeId)
    if (scope?.type === 'folder') {
      store?.updateFolderWorkspace?.(scope.folderWorkspaceId, updates)
    } else {
      store?.setWorktreeMeta(worktreeId, updates)
    }
  }
}
