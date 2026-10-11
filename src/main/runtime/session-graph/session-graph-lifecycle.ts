import type { RuntimeSessionTabsInventory } from '../session-tabs/session-tabs-inventory'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-types'
import type { RuntimeRendererReloadFence, PtyIncarnationHandleRecord } from '../orca-runtime-core'
import type { RuntimeGraphState } from './session-graph-state'
import type { RuntimeGraphReloadLifecycle } from '../runtime-graph-reload-lifecycle'
import type { SessionTabsInventoryPublication } from '../session-tabs/session-tabs-inventory-publication'
import type { RuntimeTerminalWaiterRegistry } from '../terminal/wait/terminal-waiter-registry'
import type { TerminalHandleRecord } from '../runtime-terminal-contracts'

export type RuntimeSessionGraphLifecycleHost = {
  ptys(): ReadonlyMap<string, RuntimePtyWorktreeRecord>
  resolveWorktreeSelector(selector: string): Promise<{ id: string }>
  state: RuntimeGraphState
  reload: RuntimeGraphReloadLifecycle
  publication: SessionTabsInventoryPublication
  getWaiters(): RuntimeTerminalWaiterRegistry
  handleByPtyIncarnation(): Map<string, PtyIncarnationHandleRecord>
  handleByPtyId(): Map<string, string>
  handles(): Map<string, TerminalHandleRecord>
  handleByLeafKey(): Map<string, string>
  attachWindow(windowId: number): void
  setTerminalSideEffectConsumerAvailable(available: boolean): void
  rememberDetachedPreAllocatedLeaves(): void
  invalidatePtyIncarnationHandle(ptyId: string): void
  rejectWaitersForHandle(handle: string, reason: string): void
  rejectAllWaiters(reason: string): void
  refreshWritableFlags(): void
  adoptPreAllocatedHandle(leaf: RuntimeLeafRecord): void
  reconcilePtyIncarnationHandles(): void
  clearPtyIncarnationHandles(): void
  shouldRestoreHeadlessGraph: RuntimeSessionGraphLifecycle['shouldRestoreHeadlessGraph']
  beginGraphReload: RuntimeSessionGraphLifecycle['beginGraphReload']
  restoreHeadlessGraphAuthority: RuntimeSessionGraphLifecycle['restoreHeadlessGraphAuthority']
  markSessionTabsInventoryPublished: RuntimeSessionTabsInventory['markSessionTabsInventoryPublished']
  transitionGraphReloadToTerminalState: RuntimeSessionGraphLifecycle['transitionGraphReloadToTerminalState']
  assertGraphReady: RuntimeSessionGraphLifecycle['assertGraphReady']
  captureReadyGraphEpoch: RuntimeSessionGraphLifecycle['captureReadyGraphEpoch']
  assertStableReadyGraph: RuntimeSessionGraphLifecycle['assertStableReadyGraph']
}

export class RuntimeSessionGraphLifecycle {
  constructor(private readonly host: RuntimeSessionGraphLifecycleHost) {}

  markRendererReloading(windowId: number): RuntimeRendererReloadFence | null {
    if (
      windowId !== HEADLESS_RUNTIME_WINDOW_ID &&
      this.host.state.authoritativeWindowId === HEADLESS_RUNTIME_WINDOW_ID &&
      this.host.state.headlessGraphFallbackAvailable
    ) {
      this.host.attachWindow(windowId)
      const revision = this.host.reload.getActiveRevision()
      return this.host.state.authoritativeWindowId === windowId && revision !== null
        ? { revision, recovery: 'headless' }
        : null
    }
    if (windowId !== this.host.state.authoritativeWindowId) {
      return null
    }
    if (this.host.state.graphStatus === 'reloading') {
      return {
        revision: this.host.reload.begin(windowId),
        recovery: this.host.shouldRestoreHeadlessGraph(windowId) ? 'headless' : 'reloading'
      }
    }
    if (this.host.state.graphStatus !== 'ready') {
      return null
    }
    return { revision: this.host.beginGraphReload(windowId), recovery: 'renderer' }
  }

  beginGraphReload(windowId: number): number {
    // Why: the rebuilt graph decides whether an incarnation survived; do not stale proven process identities before that comparison.
    this.host.state.rendererGraphEpoch += 1
    this.host.state.graphStatus = 'reloading'
    const revision = this.host.reload.begin(windowId)
    this.host.setTerminalSideEffectConsumerAvailable(false)
    this.host.rememberDetachedPreAllocatedLeaves()
    // A null incarnation is safe within one graph diff, but cannot prove a same-id PTY survived a renderer reload.
    for (const [ptyId, retained] of this.host.handleByPtyIncarnation()) {
      if (retained.incarnationId === null) {
        this.host.invalidatePtyIncarnationHandle(ptyId)
      }
    }
    const retainedHandles = new Set([
      ...this.host.handleByPtyId().values(),
      ...[...this.host.handleByPtyIncarnation().values()].map((record) => record.handle)
    ])
    for (const handle of this.host.getWaiters().handles()) {
      if (!retainedHandles.has(handle)) {
        this.host.rejectWaitersForHandle(handle, 'terminal_handle_stale')
      }
    }
    this.host.handles().clear()
    this.host.handleByLeafKey().clear()
    // Why: handleByPtyId (pre-allocated CLI handles) survives reloads so CLI agents keep control; adoptPreAllocatedHandle re-links on the new graph.
    // Incarnation-scoped waiters survive a renderer reload; the rebuilt graph
    // may re-adopt the same PTY and resolve them without a false stale error.
    this.host.refreshWritableFlags()
    return revision
  }

  markRendererReloadCancelled(windowId: number, fence: RuntimeRendererReloadFence): boolean {
    if (
      windowId !== this.host.state.authoritativeWindowId ||
      this.host.state.graphStatus !== 'reloading' ||
      !this.host.reload.settle(fence.revision, 'cancelled')
    ) {
      return false
    }
    if (fence.recovery === 'headless' && this.host.shouldRestoreHeadlessGraph(windowId)) {
      this.host.restoreHeadlessGraphAuthority()
      return false
    }
    if (fence.recovery === 'renderer') {
      const restoresPublishedInventory =
        this.host.publication.epoch === this.host.state.rendererGraphEpoch - 1
      this.host.state.graphStatus = 'ready'
      this.host.setTerminalSideEffectConsumerAvailable(true)
      for (const leaf of this.host.state.leaves.values()) {
        this.host.adoptPreAllocatedHandle(leaf)
      }
      this.host.reconcilePtyIncarnationHandles()
      this.host.refreshWritableFlags()
      if (restoresPublishedInventory) {
        this.host.markSessionTabsInventoryPublished()
      }
      return true
    }
    this.host.reload.begin(windowId)
    return false
  }

  markGraphReady(windowId: number): void {
    if (windowId !== this.host.state.authoritativeWindowId) {
      return
    }
    this.host.reload.settleActive('success')
    if (windowId !== HEADLESS_RUNTIME_WINDOW_ID) {
      this.host.state.headlessGraphFallbackAvailable = false
      this.host.state.pendingHeadlessPromotionWindowId = null
    }
    this.host.state.graphStatus = 'ready'
    this.host.setTerminalSideEffectConsumerAvailable(windowId !== HEADLESS_RUNTIME_WINDOW_ID)
    this.host.refreshWritableFlags()
  }

  markGraphReloadFailed(
    windowId: number,
    _reason: 'renderer-frame-unavailable' | 'renderer-process-gone'
  ): void {
    if (windowId !== this.host.state.authoritativeWindowId) {
      return
    }
    if (this.host.state.graphStatus === 'ready') {
      this.host.beginGraphReload(windowId)
    }
    this.host.reload.settleActive('failure')
    this.host.transitionGraphReloadToTerminalState(windowId)
  }

  markGraphUnavailable(windowId: number): void {
    if (
      this.host.state.authoritativeWindowId === HEADLESS_RUNTIME_WINDOW_ID &&
      windowId === this.host.state.pendingHeadlessPromotionWindowId
    ) {
      this.host.state.pendingHeadlessPromotionWindowId = null
      return
    }
    if (windowId !== this.host.state.authoritativeWindowId) {
      return
    }
    this.host.reload.settleActive('cancelled')
    if (this.host.shouldRestoreHeadlessGraph(windowId)) {
      this.host.state.pendingHeadlessPromotionWindowId = null
      this.host.restoreHeadlessGraphAuthority()
      return
    }
    // Why: once the authoritative renderer graph disappears, fail closed for live-terminal ops instead of guessing from old state.
    if (this.host.state.graphStatus !== 'unavailable') {
      this.host.state.rendererGraphEpoch += 1
    }
    this.host.state.graphStatus = 'unavailable'
    this.host.setTerminalSideEffectConsumerAvailable(false)
    this.host.state.authoritativeWindowId = null
    this.host.rememberDetachedPreAllocatedLeaves()
    for (const [ptyId, handle] of this.host.handleByPtyId()) {
      if (this.host.handleByPtyIncarnation().get(ptyId)?.handle === handle) {
        this.host.handleByPtyId().delete(ptyId)
      }
    }
    this.host.state.tabs.clear()
    this.host.state.leaves.clear()
    this.host.state.leavesByPtyId.clear()
    this.host.handles().clear()
    this.host.handleByLeafKey().clear()
    this.host.clearPtyIncarnationHandles()
    // Why: pre-allocated CLI handles must survive graph unavailability so they can be re-adopted on reconnect.
    this.host.rejectAllWaiters('terminal_handle_stale')
  }

  handleGraphReloadTimeout(windowId: number): void {
    if (
      windowId !== this.host.state.authoritativeWindowId ||
      this.host.state.graphStatus !== 'reloading'
    ) {
      return
    }
    this.host.transitionGraphReloadToTerminalState(windowId)
  }

  transitionGraphReloadToTerminalState(windowId: number): void {
    if (this.host.shouldRestoreHeadlessGraph(windowId)) {
      this.host.restoreHeadlessGraphAuthority()
      return
    }
    this.host.state.graphStatus = 'unavailable'
    this.host.setTerminalSideEffectConsumerAvailable(false)
    this.host.rememberDetachedPreAllocatedLeaves()
    this.host.state.tabs.clear()
    this.host.state.leaves.clear()
    this.host.state.leavesByPtyId.clear()
    this.host.handles().clear()
    this.host.handleByLeafKey().clear()
    this.host.clearPtyIncarnationHandles()
    this.host.rejectAllWaiters('terminal_handle_stale')
    this.host.refreshWritableFlags()
  }

  shouldRestoreHeadlessGraph(windowId: number): boolean {
    return windowId !== HEADLESS_RUNTIME_WINDOW_ID && this.host.state.headlessGraphFallbackAvailable
  }

  restoreHeadlessGraphAuthority(): void {
    this.host.state.rendererGraphEpoch += 1
    this.host.state.authoritativeWindowId = HEADLESS_RUNTIME_WINDOW_ID
    this.host.state.graphStatus = 'ready'
    this.host.state.rendererGeneration = null
    this.host.setTerminalSideEffectConsumerAvailable(false)
    this.host.state.tabs.clear()
    this.host.state.leaves.clear()
    this.host.state.leavesByPtyId.clear()
    this.host.handles().clear()
    this.host.handleByLeafKey().clear()
    this.host.clearPtyIncarnationHandles()
    this.host.rejectAllWaiters('terminal_handle_stale')
    this.host.refreshWritableFlags()
    this.host.markSessionTabsInventoryPublished()
  }

  assertGraphReady(): void {
    if (this.host.state.graphStatus !== 'ready') {
      throw new Error('runtime_unavailable')
    }
  }

  captureReadyGraphEpoch(): number {
    this.host.assertGraphReady()
    return this.host.state.rendererGraphEpoch
  }

  assertStableReadyGraph(expectedGraphEpoch: number): void {
    if (
      this.host.state.graphStatus !== 'ready' ||
      this.host.state.rendererGraphEpoch !== expectedGraphEpoch
    ) {
      throw new Error('runtime_unavailable')
    }
  }
  async hasTerminalsForWorktree(worktreeSelector: string): Promise<boolean> {
    const graphEpoch = this.host.captureReadyGraphEpoch()
    const worktree = await this.host.resolveWorktreeSelector(worktreeSelector)
    this.host.assertStableReadyGraph(graphEpoch)
    for (const leaf of this.host.state.leaves.values()) {
      if (leaf.worktreeId === worktree.id && leaf.ptyId) {
        return true
      }
    }
    for (const pty of this.host.ptys().values()) {
      if (pty.worktreeId === worktree.id && pty.connected) {
        return true
      }
    }
    return false
  }
}
