import type { TerminalSplitOptions } from './terminal-split-surface'
import type { SplitPaneInMainOptions, SplitPaneSource } from './terminal-split-in-main'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import { OrcaRuntimeWithStopExplicitlyClosedTabPtys } from '../../session-tabs/explicit-terminal-close-stops'
import type { TerminalPaneSplitSource } from '../../../../shared/feature-education-telemetry'
import type { RuntimeTerminalSplit } from '../../../../shared/runtime-types'
import { randomUUID } from 'node:crypto'
import {
  RendererSplitLedger,
  splitPaneClosedError,
  splitRetryUnknownError,
  type RendererSplitRequest
} from './terminal-split-retry'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { Worktree } from '../../../../shared/worktree/types'

export abstract class OrcaRuntimeWithSplitTerminal extends OrcaRuntimeWithStopExplicitlyClosedTabPtys {
  protected abstract splitPtyBackedTerminal(
    pty: RuntimePtyWorktreeRecord,
    opts?: TerminalSplitOptions,
    createdWorktree?: Worktree
  ): Promise<RuntimeTerminalSplit>

  protected abstract ownsTabLayout(worktreeId: string, tabId: string): boolean

  protected abstract splitPaneInMain(
    source: SplitPaneSource,
    opts: SplitPaneInMainOptions
  ): Promise<RuntimeTerminalSplit>

  protected abstract waitForLeafInTab(tabId: string, leafId: string): Promise<string>

  private readonly rendererSplits = new RendererSplitLedger()
  private rendererSplitWatch: (() => void) | null = null

  async splitTerminal(
    handle: string,
    opts: {
      direction?: 'horizontal' | 'vertical'
      command?: string
      env?: Record<string, string>
      envToDelete?: string[]
      activate?: boolean
      // Why: same split as createTerminal — adopt the pane without revealing its
      // workspace, for splits the user never asked to see.
      surfaceOwner?: false
      telemetrySource?: TerminalPaneSplitSource
      /** The leaf id a timed-out split reported: wait for that pane instead of splitting again. */
      retrySplit?: string
    } = {},
    // Internal creation evidence; RPC and preload callers never supply it.
    createdWorktree?: Worktree
  ): Promise<RuntimeTerminalSplit> {
    const livePty = this.getLivePtyForHandle(handle)
    if (livePty && opts.retrySplit) {
      // Main starts these splits itself and answers without the window, so none can be pending.
      throw splitRetryUnknownError(livePty.record.tabId, opts.retrySplit)
    }
    if (livePty) {
      return await this.splitPtyBackedTerminal(livePty.pty, opts, createdWorktree)
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    const direction = opts.direction ?? 'horizontal'
    // Switch point: main writes the split and starts its terminal; the window attaches to it.
    if (ORCA_LAYOUT_OWNER_IS_MAIN && this.ownsTabLayout(leaf.worktreeId, leaf.tabId)) {
      if (opts.retrySplit) {
        throw splitRetryUnknownError(leaf.tabId, opts.retrySplit)
      }
      const cwd = leaf.ptyId
        ? await this.ptyController?.getCwd?.(leaf.ptyId).catch(() => null)
        : null
      return this.splitPaneInMain(
        { worktreeId: leaf.worktreeId, tabId: leaf.tabId, leafId: leaf.leafId },
        {
          direction,
          ...(cwd ? { cwd } : {}),
          command: opts.command,
          env: opts.env,
          envToDelete: opts.envToDelete,
          activate: opts.activate
        }
      )
    }

    const newLeafId = opts.retrySplit ?? randomUUID()
    const request: RendererSplitRequest = opts.retrySplit
      ? this.rendererSplitForRetry(leaf.tabId, opts.retrySplit)
      : {
          tabId: leaf.tabId,
          paneRuntimeId: leaf.paneRuntimeId,
          direction,
          command: opts.command,
          worktreeId: leaf.worktreeId,
          sourceLeafId: leaf.leafId,
          telemetrySource: opts.telemetrySource
        }
    if (!opts.retrySplit) {
      this.rendererSplits.record(newLeafId, request)
    }
    this.watchRendererSplits()
    if (!this.leaves.has(this.getLeafKey(request.tabId, newLeafId))) {
      // A retry re-sends the same leaf id; the window skips a split whose pane it already made.
      const { tabId, paneRuntimeId, ...split } = request
      this.notifier?.splitTerminal(tabId, paneRuntimeId, { ...split, newLeafId })
    }

    const newHandle = await this.waitForLeafInTab(request.tabId, newLeafId)
    return {
      handle: newHandle,
      tabId: request.tabId,
      paneRuntimeId: request.paneRuntimeId,
      leafId: newLeafId
    }
  }

  private rendererSplitForRetry(tabId: string, leafId: string): RendererSplitRequest {
    const entry = this.rendererSplits.get(leafId)
    if (!entry || entry.request.tabId !== tabId) {
      throw splitRetryUnknownError(tabId, leafId)
    }
    if (entry.seen && !this.leaves.has(this.getLeafKey(tabId, leafId))) {
      throw splitPaneClosedError(tabId, leafId)
    }
    // A remounted source pane gets a new runtime id; the window routes by the live one.
    const source = this.leaves.get(this.getLeafKey(tabId, entry.request.sourceLeafId))
    return source ? { ...entry.request, paneRuntimeId: source.paneRuntimeId } : entry.request
  }

  /** Watches graph syncs while a split is unseen, so a pane closed after a timeout is not re-made. */
  private watchRendererSplits(): void {
    if (this.rendererSplitWatch) {
      return
    }
    const watch = (): void => {
      const unseen = this.rendererSplits.observe((tabId, leafId) =>
        this.leaves.has(this.getLeafKey(tabId, leafId))
      )
      if (!unseen) {
        const idx = this.graphSyncCallbacks.indexOf(watch)
        if (idx !== -1) {
          this.graphSyncCallbacks.splice(idx, 1)
        }
        this.rendererSplitWatch = null
      }
    }
    this.rendererSplitWatch = watch
    this.graphSyncCallbacks.push(watch)
  }
}
