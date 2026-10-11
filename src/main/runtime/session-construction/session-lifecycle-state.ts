import type {
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeTerminalFocus,
  RuntimeTerminalResolvePane,
  RuntimeWorktreeTerminalSleepResult
} from '../../../shared/runtime-types'

import { preserveTerminalRetirementProofs } from '../mobile-session-terminal-retirement-proof'

import { ClientSessionTabSelectionStore } from '../client-session-tab-selection'

import type { PtyIncarnationId } from '../../../shared/pty-incarnation'

import { TerminalFocusNavigationCoalescer } from '../terminal-focus-navigation-coalescer'
import type {
  PtyControllerInventory,
  RuntimePtyController
} from '../runtime-pty-controller-contract'

import type { PtyLivenessVerdict } from '../../../shared/pty-liveness-verdict'
import { RuntimeSessionGraphStateOwner } from './session-graph-state-owner'

export abstract class RuntimeSessionLifecycleState extends RuntimeSessionGraphStateOwner {
  protected mobileSessionTabsByWorktree = new Map<string, RuntimeMobileSessionTabsSnapshot>()

  /** Single host writer for mobile session snapshots; versions are total-order stamps. */
  protected storeMobileSessionSnapshot(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot {
    const existing = this.mobileSessionTabsByWorktree.get(worktreeId)
    snapshot = preserveTerminalRetirementProofs(snapshot, existing)
    const snapshotVersion = existing
      ? Math.max(snapshot.snapshotVersion, existing.snapshotVersion + 1)
      : snapshot.snapshotVersion
    const stamped =
      snapshotVersion === snapshot.snapshotVersion ? snapshot : { ...snapshot, snapshotVersion }
    this.mobileSessionTabsByWorktree.set(worktreeId, stamped)
    return stamped
  }

  protected structuredAgentSessionStartupRestorePromise: Promise<void> | null = null

  protected mobileSessionTabsChangeSequence = 0

  // Worktrees answered with the unpublished placeholder, owed their real answer once the graph publishes.
  protected worktreesAwaitingSessionTabsPublication = new Set<string>()

  // Main-local touches advance stored versions; reject unchanged renderer resends using
  // the renderer's last accepted epoch/version instead.
  protected acceptedRendererMobileSnapshotByWorktree = new Map<
    string,
    {
      publicationEpoch: string
      rendererVersion: number
      rendererTabCount: number
      rendererTabIdentityKeys: ReadonlySet<string>
    }
  >()

  // Why: worktree ids are path-derived and get recreated, so a renderer frame
  // that raced the delete must be rejected by the removed occupant's identity.
  // Entries are cleared once a snapshot carrying the successor's instanceId
  // is accepted; identity-less frames are fenced by renderer generation.
  protected readonly removedMobileSessionWorktreeIds = new Map<
    string,
    {
      removedPublicationEpoch?: string
      // Why: a rejected frame is still "published" on the renderer side, so a
      // later unchanged-list mention must not spiral into resync requests.
      rejectedPublication?: boolean
    }
  >()

  protected clientSessionTabSelections = new ClientSessionTabSelectionStore()

  // Why: idempotency map for mobile terminal creation — a retried create with the
  // same clientMutationId returns the in-flight operation instead of duplicating.
  protected mobileTerminalCreateByMutationId = new Map<
    string,
    Promise<RuntimeMobileSessionCreateTerminalResult>
  >()

  // Why: concurrent clients sleeping one host workspace must share one physical teardown.
  protected terminalSleepByWorktreeId = new Map<
    string,
    Promise<RuntimeWorktreeTerminalSleepResult>
  >()

  protected terminalSleepStateByWorktreeId = new Map<
    string,
    {
      worktreeId: string
      generation: number
      phase: 'stopping' | 'partial' | 'sleeping'
      ptyIds: string[]
      terminalHandles: string[]
      terminalHandlesByPtyId: Record<string, string[]>
    }
  >()

  protected terminalSleepGeneration = 0

  protected terminalPaneRecoveryByIdentity = new Map<string, Promise<RuntimeTerminalResolvePane>>()

  // Why: idempotency map for worktree.create — a create interrupted by a mobile
  // connection migration is retried with the same clientMutationId and returns
  // the in-flight (or just-finished) operation instead of a duplicate worktree.
  protected worktreeCreateByMutationId = new Map<string, Promise<unknown>>()

  // Why: a mobile create waits for the renderer to publish the new tab's surface
  // via graph-sync, but a throttled/hidden renderer can park that past the surface
  // timeout and the create would then destroy the live PTY (#7587). This lets the
  // renderer's own PTY spawn publish the surface main-side, scoped to in-flight
  // creates so ordinary renderer spawns never publish here.
  protected pendingMobileTerminalCreatesByKey = new Map<
    string,
    {
      activate: boolean
      paired: boolean
      selectIfNoActiveTab: boolean
      viewMode?: 'terminal' | 'chat'
      /** Resolved agent launch command, kept so a settle over a bare renderer
       *  PTY can still deliver the launch instead of succeeding silently (STA-3214). */
      startupCommand?: string
    }
  >()

  protected mobileSessionTabListeners = new Set<{
    listener: (snapshot: RuntimeMobileSessionTabsResult, changeSequence: number) => void
    clientNavigationId?: string
  }>()

  protected pendingMobileSessionTabsChangeSequenceByWorktree = new Map<string, number>()

  // Why: one watermark per repo replaces per-closed-pane fences while preserving stale-write safety.
  protected terminalTopologyRevisionByRepoId = new Map<string, number>()

  // Why: provider exit can beat surface registration; that exact dead incarnation must never publish.
  protected earlyExitedPtyIncarnations = new Map<string, PtyIncarnationId | null>()

  protected pendingPtyRegistrationIncarnations = new Map<string, PtyIncarnationId | null>()

  // Concurrent focus requests share one host reveal; the latest pane wins.
  protected readonly terminalFocusNavigationCoalescer =
    new TerminalFocusNavigationCoalescer<RuntimeTerminalFocus>()

  protected pendingMobileSessionPtyAggregateInventoryRefresh: Promise<PtyControllerInventory | null> | null =
    null

  // Why: pointer state is process-local; one harmless replay after restart avoids a wire or schema change.
  protected readonly lastPointedMessageSequenceByHandle = new Map<string, number>()

  // Why: a waiter can reserve an older row while a newer row advances the sequence watermark.
  protected readonly pointedMessageIdsByHandle = new Map<string, Set<string>>()

  protected ptyController: RuntimePtyController | null = null

  protected readonly ptyLivenessVerdictByPtyId = new Map<
    string,
    { verdict: PtyLivenessVerdict; observedAt: number }
  >()

  protected ptyLivenessObservationSequence = 0
}
