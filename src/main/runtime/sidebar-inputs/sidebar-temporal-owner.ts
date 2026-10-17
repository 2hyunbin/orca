import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import {
  CREATE_GRACE_MS,
  type WorkspaceSortBy
} from '../../../shared/workspace-view/workspace-row-sort'
import {
  INITIAL_SORT_SETTLE_STATE,
  reduceSortSettle,
  type SortSettleEvent
} from '../../../shared/sidebar-list/sort-settle'
import { ranksFollowPersistedOrder } from '../../../shared/sidebar-list/smart-sort-phase'
import {
  rankWorktreesForSort,
  type SmartSortSources
} from '../../../shared/sidebar-list/smart-sort'
import {
  createSleepingSweepRetentionState,
  updateSleepingSweepRetention
} from '../../../shared/sidebar-list/sleeping-sweep-retention'
import type {
  SidebarRetention,
  SidebarSortSnapshot,
  SidebarTemporalSnapshot
} from '../../../shared/sidebar-list/sidebar-temporal-snapshot'
import type { SidebarClock } from './sidebar-clock'

/** What one settle sorts: every row this host lists, and the records Smart scores. */
export type SidebarSortSample = {
  worktrees: Worktree[]
  repoMap: Map<string, Pick<Repo, 'displayName'>>
  sources: SmartSortSources
}

/** The sweep's view of one workspace, by bare id. */
export type SidebarRetentionCandidates = {
  /** Active ids; the last sample's rows are added to them. */
  ids: Iterable<string>
  isActive: (worktreeId: string) => boolean
  /** False when the inactivity is definitive: a sleep this host started, or no terminal tab left. */
  isUnverifiableGap: (worktreeId: string) => boolean
}

export type SidebarTemporalInputs = {
  sortBy: () => WorkspaceSortBy
  showSleepingWorkspaces: () => boolean
  /** May scan the host's worktrees; a later settle supersedes a slow read. */
  readSortSample: () => Promise<SidebarSortSample>
  retentionCandidates: () => SidebarRetentionCandidates
}

const SETTLE_DEADLINE = 'sort-settle'
const CREATE_GRACE_DEADLINE = 'create-grace'
const RETENTION_DEADLINE = 'sleeping-retention'

/**
 * Main's copy of the list's time rules: when the frozen order settles, whether Smart has latched,
 * and which sleeping rows the sweep still keeps. The window still runs its own; this one is
 * compared against it and never persists ranks.
 */
export class SidebarTemporalOwner {
  private revision = 0
  private sessionId: string | null = null
  private settleState = INITIAL_SORT_SETTLE_STATE
  private sortBy: WorkspaceSortBy
  private smartLatched = false
  private epoch = 0
  private sortSnapshot: SidebarSortSnapshot | null = null
  // A sample started before a reset or a later settle must not land.
  private sampleSeq = 0
  private identityById = new Map<string, string>()
  private retentionState = createSleepingSweepRetentionState()
  private retention: SidebarRetention | null = null

  constructor(
    private readonly clock: SidebarClock,
    private readonly inputs: SidebarTemporalInputs
  ) {
    this.sortBy = inputs.sortBy()
  }

  snapshot(): SidebarTemporalSnapshot {
    return {
      revision: this.revision,
      sessionId: this.sessionId,
      sortSnapshot: this.sortSnapshot,
      retention: this.retention
    }
  }

  /** The window mounted its list: Smart goes cold and retention forgets, as on today's remount. */
  beginSession(sessionId: string): void {
    if (sessionId === this.sessionId) {
      return
    }
    this.sessionId = sessionId
    this.smartLatched = false
    this.epoch = 0
    // Until the new session's first sample lands, a reader must not take the old warm ranks.
    this.sortSnapshot = null
    this.retentionState = createSleepingSweepRetentionState()
    this.revision += 1
    this.retentionPass()
    this.settleNow()
  }

  /** A change the sort reads; it settles after the burst, or at once when the row count moved. */
  noteSortInputChange(liveWorktreeCount?: number): void {
    this.dispatchSettle({
      kind: 'write',
      change: {
        epochBumped: true,
        liveCount: liveWorktreeCount ?? this.settleState.liveCountAtLastBump
      },
      settled: false,
      sortBy: this.sortBy,
      previousSortBy: this.sortBy
    })
  }

  /** Rows changed: Manual and cold Smart follow saved ranks at once, as the window does. */
  noteRowsChange(liveWorktreeCount?: number): void {
    this.noteSortInputChange(liveWorktreeCount)
    if (ranksFollowPersistedOrder(this.sortBy, this.smartLatched)) {
      this.settleNow()
    }
  }

  noteActivityChange(): void {
    this.retentionPass()
    this.noteSortInputChange()
  }

  /** The sort mode or the sleeping filter may have changed. */
  noteViewChange(): void {
    const previousSortBy = this.sortBy
    this.sortBy = this.inputs.sortBy()
    if (this.sortBy !== previousSortBy) {
      this.dispatchSettle({
        kind: 'write',
        change: null,
        settled: false,
        sortBy: this.sortBy,
        previousSortBy
      })
    }
    this.retentionPass()
  }

  dispose(): void {
    this.sampleSeq += 1
    for (const key of [SETTLE_DEADLINE, CREATE_GRACE_DEADLINE, RETENTION_DEADLINE]) {
      this.clock.cancel(key)
    }
  }

  private dispatchSettle(event: SortSettleEvent): void {
    const step = reduceSortSettle(this.settleState, event, Date.now())
    const deadline = step.state.deadline
    if (deadline !== this.settleState.deadline) {
      if (deadline === null) {
        this.clock.cancel(SETTLE_DEADLINE)
      } else {
        this.clock.schedule(SETTLE_DEADLINE, deadline, () =>
          this.dispatchSettle({ kind: 'deadline' })
        )
      }
    }
    this.settleState = step.state
    if (step.settle) {
      this.settleNow()
    }
  }

  private settleNow(): void {
    const seq = ++this.sampleSeq
    void this.inputs.readSortSample().then(
      (sample) => {
        if (seq === this.sampleSeq) {
          this.applySample(sample)
        }
      },
      (error: unknown) => console.warn('[sidebar-temporal] could not read the rows to sort', error)
    )
  }

  private applySample(sample: SidebarSortSample): void {
    const now = Date.now()
    const ranking = rankWorktreesForSort({
      worktrees: sample.worktrees.filter((worktree) => !worktree.isArchived),
      sortBy: this.sortBy,
      latched: this.smartLatched,
      repoMap: sample.repoMap,
      now,
      sources: sample.sources
    })
    this.smartLatched ||= ranking.detectedLiveSmartSignal
    this.epoch += 1
    this.sortSnapshot = {
      mode: this.sortBy,
      epoch: this.epoch,
      sampledAt: now,
      rankedIds: ranking.sorted.map(getWorktreeHostIdentity),
      smartLatched: this.smartLatched
    }
    this.identityById = new Map(
      sample.worktrees.map((worktree) => [worktree.id, getWorktreeHostIdentity(worktree)])
    )
    this.revision += 1
    this.scheduleCreateGraceBoundary(ranking.sorted, now)
  }

  // Recent ranks a new row at its grace floor until the window closes; re-sort when it does.
  private scheduleCreateGraceBoundary(worktrees: readonly Worktree[], now: number): void {
    let next = Infinity
    if (this.sortBy === 'recent' || this.sortBy === 'smart') {
      for (const { createdAt } of worktrees) {
        const closesAt = (createdAt ?? -Infinity) + CREATE_GRACE_MS
        if (closesAt > now && closesAt < next) {
          next = closesAt
        }
      }
    }
    if (next === Infinity) {
      this.clock.cancel(CREATE_GRACE_DEADLINE)
    } else {
      this.clock.schedule(CREATE_GRACE_DEADLINE, next, () => this.settleNow())
    }
  }

  private retentionPass(): void {
    if (this.inputs.showSleepingWorkspaces()) {
      this.retentionState = createSleepingSweepRetentionState()
      this.clock.cancel(RETENTION_DEADLINE)
      if (this.retention !== null) {
        this.retention = null
        this.revision += 1
      }
      return
    }
    const candidates = this.inputs.retentionCandidates()
    const now = Date.now()
    const { retainedIds, nextExpiryInMs } = updateSleepingSweepRetention({
      state: this.retentionState,
      // The last sample's rows too, so an id that just went idle is not pruned out of its grace.
      candidateWorktreeIds: [...new Set([...candidates.ids, ...this.identityById.keys()])],
      isActive: candidates.isActive,
      isUnverifiableGap: candidates.isUnverifiableGap,
      nowMs: now
    })
    if (nextExpiryInMs === null) {
      this.clock.cancel(RETENTION_DEADLINE)
    } else {
      this.clock.schedule(RETENTION_DEADLINE, now + nextExpiryInMs, () => this.retentionPass())
    }
    const ids = [...retainedIds].map((id) => this.identityById.get(id) ?? id).sort()
    const previous = this.retention?.retainedIds
    if (!previous || previous.length !== ids.length || previous.some((id, i) => id !== ids[i])) {
      this.retention = { retainedIds: ids, retentionDecidedAt: now }
      this.revision += 1
    }
  }
}
