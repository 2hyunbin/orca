import { resolveAgentStatusWorktreeId } from '../../../shared/agent-status-worktree-attribution'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import {
  getConnectionExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import {
  classifySortStampEvent,
  hookRowAgentPhase,
  nextAgentPaneState,
  REST_PANE,
  titleAgentPhase,
  type AgentPaneState,
  type AgentPhase,
  type SortStampEvent
} from '../../../shared/sidebar-list/sort-stamps'
import type { TerminalSideEffectBatch } from '../../../shared/terminal-side-effect-facts'
import type { AgentStatusStoreView } from './workspace-activity-facts-producer'
import {
  listThisMachineTieredWorkspaces,
  readSortStamps,
  writeSortStamps,
  type SortStampsStore,
  type WorkspaceRef
} from './sort-stamp-records'

export type { SortStampsStore } from './sort-stamp-records'

/** A terminal this host holds at attach, with the title it last showed. */
export type LiveTitlePane = {
  ptyId: string
  paneKey: string
  worktreeId: string
  connectionId: string | null
  title: string
}

export type SortStampsSources = {
  store: () => SortStampsStore | null
  /** A WSL move freezes the project; stamps are background bookkeeping it drops. */
  isWriteFenced: (worktreeId: string) => boolean
  resolveTabWorktreeId: (tabId: string) => string | undefined
  subscribeToPtyExit: (ptyId: string, listener: () => void) => () => void
  liveTitlePanes: () => Iterable<LiveTitlePane>
  /** Consumes terminal side effects, so the host scans its own bytes for bells and titles. */
  onClientEvent: (
    listener: (event: RuntimeClientEvent) => void,
    options: { consumesTerminalSideEffects: true }
  ) => () => void
  now: () => number
}

type TrackedPane = WorkspaceRef & { state: AgentPaneState }
type TitlePane = { ptyId: string; releaseExit: () => void }

function sshHostOfConnection(connectionId: string | null | undefined): ExecutionHostId | null {
  const hostId = getConnectionExecutionHostId(connectionId)
  return hostId === LOCAL_EXECUTION_HOST_ID ? null : hostId
}

function sameWorkspace(a: WorkspaceRef | undefined, b: WorkspaceRef | null): boolean {
  return !!a && !!b && a.worktreeId === b.worktreeId && a.sshHostId === b.sshHostId
}

/**
 * Writes the sort stamps of every workspace this host owns, at the source: hook-store transitions
 * (terminal agents and structured chats), hookless agents' titles, bells, and terminals a CLI
 * starts. Creation stamps itself where the record is made. Rest panes are not kept.
 */
export class SortStampsProducer {
  private readonly panes = new Map<string, TrackedPane>()
  /** Hookless panes seen since their PTY started: the first title seeds, it is not a transition. */
  private readonly titlePanes = new Map<string, TitlePane>()
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
    for (const pane of this.sources.liveTitlePanes()) {
      if (!this.latestHookRow(pane.paneKey)) {
        const workspace = {
          worktreeId: pane.worktreeId,
          sshHostId: sshHostOfConnection(pane.connectionId)
        }
        this.observeTitlePane(pane.ptyId, pane.paneKey, workspace, titleAgentPhase(pane.title))
      }
    }
    this.clearUnbackedTiers()
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
  noteTerminalStarted(worktreeId: string, hostId: ExecutionHostId | undefined): void {
    const sshHostId = parseExecutionHostId(hostId)?.kind === 'ssh' ? (hostId ?? null) : null
    this.stamp({ worktreeId, sshHostId }, { kind: 'terminal-started' })
  }

  // A tier this machine stored with no hook row and no live terminal behind it ended with the last run.
  private clearUnbackedTiers(): void {
    const backed = new Set<string>()
    for (const pane of this.panes.values()) {
      if (!pane.sshHostId) {
        backed.add(pane.worktreeId)
      }
    }
    for (const worktreeId of listThisMachineTieredWorkspaces(this.sources.store())) {
      if (!backed.has(worktreeId)) {
        this.writeAgentChange({ worktreeId, sshHostId: null }, 'rest', 'rest', this.sources.now())
      }
    }
  }

  private observeHookPane(paneKey: string, seed: boolean): void {
    const latest = this.latestHookRow(paneKey)
    if (!latest) {
      this.move(paneKey, null, 'rest', this.sources.now())
      return
    }
    const worktreeId = resolveAgentStatusWorktreeId(latest, {
      get: this.sources.resolveTabWorktreeId
    })
    const workspace = worktreeId
      ? { worktreeId, sshHostId: sshHostOfConnection(latest.connectionId) }
      : null
    const phase = hookRowAgentPhase(latest)
    if (seed || latest.restoredUnconfirmed || latest.isReplay) {
      this.seed(paneKey, workspace, phase, latest.stateStartedAt)
    } else {
      this.move(paneKey, workspace, phase, this.sources.now())
    }
  }

  // The window applies a pane's rows in arrival order, so the newest is the one it holds.
  private latestHookRow(paneKey: string): AgentStatusIpcPayload | null {
    let latest: AgentStatusIpcPayload | null = null
    for (const row of this.agentStore?.getStatusSnapshotForPane(paneKey) ?? []) {
      if (!row.providerSessionOnly && (!latest || row.receivedAt > latest.receivedAt)) {
        latest = row
      }
    }
    return latest
  }

  private noteTerminalSideEffects(batch: TerminalSideEffectBatch): void {
    const { worktreeId, paneKey } = batch
    if (!worktreeId) {
      return
    }
    const workspace = { worktreeId, sshHostId: sshHostOfConnection(batch.connectionId) }
    for (const fact of batch.facts) {
      if (fact.kind === 'bell') {
        this.stamp(workspace, { kind: 'bell' })
      } else if (fact.kind === 'title' && paneKey && !this.latestHookRow(paneKey)) {
        // Hook authority is per pane, as in Smart's attention. A cleared stale working title is a
        // timer's guess, not a finish.
        const phase = fact.staleWorkingTitleClear ? 'rest' : titleAgentPhase(fact.rawTitle)
        this.observeTitlePane(batch.ptyId, paneKey, workspace, phase)
      }
    }
  }

  private observeTitlePane(
    ptyId: string,
    paneKey: string,
    workspace: WorkspaceRef,
    phase: AgentPhase
  ): void {
    const known = this.titlePanes.get(paneKey)
    if (known?.ptyId === ptyId) {
      this.move(paneKey, workspace, phase, this.sources.now())
      return
    }
    // A new PTY in the pane is a new agent; the last one left with its terminal.
    if (known) {
      this.endTitlePane(paneKey)
    }
    let exited = false
    const releaseExit = this.sources.subscribeToPtyExit(ptyId, () => {
      exited = true
      this.endTitlePane(paneKey)
    })
    if (exited) {
      return
    }
    this.titlePanes.set(paneKey, { ptyId, releaseExit })
    // An agent idle at its first title has finished no turn, unless the record says it had.
    const seeded =
      phase === 'done' && readSortStamps(this.sources.store(), workspace)?.smartTier !== 'done'
        ? 'rest'
        : phase
    this.seed(paneKey, workspace, seeded, this.sources.now())
  }

  private endTitlePane(paneKey: string): void {
    this.titlePanes.get(paneKey)?.releaseExit()
    this.titlePanes.delete(paneKey)
    this.move(paneKey, null, 'rest', this.sources.now())
  }

  /**
   * Takes the observed phase as it is and reconciles the tier, without a Recent stamp. A phase the
   * record already holds keeps its time, so a restart rewrites nothing.
   */
  private seed(
    paneKey: string,
    workspace: WorkspaceRef | null,
    phase: AgentPhase,
    observedAt: number
  ): void {
    const previous = this.panes.get(paneKey)
    if (previous && !sameWorkspace(previous, workspace)) {
      this.move(paneKey, null, 'rest', this.sources.now())
    }
    if (!workspace) {
      return
    }
    const stored = readSortStamps(this.sources.store(), workspace)
    const state = {
      phase,
      at: stored?.smartTier === phase && stored.smartAt !== undefined ? stored.smartAt : observedAt
    }
    if (state.phase === 'rest') {
      this.panes.delete(paneKey)
    } else {
      this.panes.set(paneKey, { ...workspace, state })
    }
    this.writeAgentChange(workspace, state.phase, state.phase, this.sources.now())
  }

  /** One pane observed in `observed`; a pane that left or changed workspace rests where it was. */
  private move(
    paneKey: string,
    workspace: WorkspaceRef | null,
    observed: AgentPhase,
    at: number
  ): void {
    const previous = this.panes.get(paneKey)
    if (previous && !sameWorkspace(previous, workspace)) {
      this.panes.delete(paneKey)
      this.writeAgentChange(previous, previous.state.phase, 'rest', at)
    }
    if (!workspace) {
      return
    }
    const before = sameWorkspace(previous, workspace) ? previous!.state : REST_PANE
    const state = nextAgentPaneState(before, observed, at)
    if (state === before) {
      return
    }
    if (state.phase === 'rest') {
      this.panes.delete(paneKey)
    } else {
      this.panes.set(paneKey, { ...workspace, state })
    }
    this.writeAgentChange(workspace, before.phase, state.phase, at)
  }

  private writeAgentChange(
    workspace: WorkspaceRef,
    from: AgentPhase,
    to: AgentPhase,
    now: number
  ): void {
    const panes: AgentPaneState[] = []
    for (const pane of this.panes.values()) {
      if (sameWorkspace(pane, workspace)) {
        panes.push(pane.state)
      }
    }
    this.stamp(workspace, { kind: 'agent', from, to, panes }, now)
  }

  // One clock read per event, so a pane's time and its Recent stamp agree.
  private stamp(workspace: WorkspaceRef, event: SortStampEvent, now = this.sources.now()): void {
    // A WSL move only takes this machine's projects.
    if (!workspace.sshHostId && this.sources.isWriteFenced(workspace.worktreeId)) {
      return
    }
    const current = readSortStamps(this.sources.store(), workspace)
    const next = current && classifySortStampEvent(current, event, now)
    if (next) {
      writeSortStamps(this.sources.store(), workspace, next)
    }
  }
}
