import type { TerminalSplitOptions } from './terminal-split-surface'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import { OrcaRuntimeWithStopExplicitlyClosedTabPtys } from '../../session-tabs/explicit-terminal-close-stops'
import type { TerminalPaneSplitSource } from '../../../../shared/feature-education-telemetry'
import type { RuntimeTerminalSplit } from '../../../../shared/runtime-types'
import { randomUUID } from 'node:crypto'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { startInAdmittedPane } from '../../runtime-pane-admission'
import type { Worktree } from '../../../../shared/worktree/types'

export abstract class OrcaRuntimeWithSplitTerminal extends OrcaRuntimeWithStopExplicitlyClosedTabPtys {
  /** Pane id of each split main wrote and awaits → whether the window already recorded it. */
  private readonly awaitedSplitLeafIds = new Map<string, boolean>()

  /** Splits main asked for but does not hold by its own doing (taken back unshown, or never
   *  written): the window's record of one may write it. */
  private readonly recordableSplitLeafIds = new Set<string>()

  /**
   * The window recorded a split it mounted: one main awaits counts as shown before its graph says
   * so. True when main does not hold that split by its own doing, so the record may write it.
   */
  protected noteWindowMountedSplit(leafId: string): boolean {
    if (this.awaitedSplitLeafIds.has(leafId)) {
      this.awaitedSplitLeafIds.set(leafId, true)
    }
    return this.recordableSplitLeafIds.delete(leafId)
  }

  protected abstract splitPtyBackedTerminal(
    pty: RuntimePtyWorktreeRecord,
    opts?: TerminalSplitOptions,
    createdWorktree?: Worktree
  ): Promise<RuntimeTerminalSplit>

  protected abstract waitForLeafInTab(
    tabId: string,
    leafId: string,
    timeoutMs?: number
  ): Promise<string>

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
    } = {},
    // Internal creation evidence; RPC and preload callers never supply it.
    createdWorktree?: Worktree
  ): Promise<RuntimeTerminalSplit> {
    const livePty = this.getLivePtyForHandle(handle)
    if (livePty) {
      return await this.splitPtyBackedTerminal(livePty.pty, opts, createdWorktree)
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    const direction = opts.direction ?? 'horizontal'
    // Switch point: main writes the split first; the window then mounts main's pane.
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      const [hostId] = this.getWorkspaceSessionHostIdsForTab(leaf.worktreeId, leaf.tabId)
      if (hostId && parseExecutionHostId(hostId)?.kind !== 'runtime') {
        const newLeafId = randomUUID()
        this.awaitedSplitLeafIds.set(newLeafId, false)
        const { result: newHandle } = await startInAdmittedPane(
          this.store,
          {
            type: 'splitPane',
            workspace: leaf.worktreeId,
            tabId: leaf.tabId,
            leafId: leaf.leafId,
            direction,
            newLeafId
          },
          hostId,
          // A refused or failed write splits as today; the window's record of it writes the pane.
          (outcome) => {
            if (outcome !== 'admitted' && outcome !== 'exists') {
              rememberRecordable(this.recordableSplitLeafIds, newLeafId)
            }
            this.notifier?.splitTerminal(leaf.tabId, leaf.paneRuntimeId, {
              direction,
              command: opts.command,
              worktreeId: leaf.worktreeId,
              sourceLeafId: leaf.leafId,
              telemetrySource: opts.telemetrySource,
              newLeafId
            })
            return this.waitForLeafInTab(leaf.tabId, newLeafId)
          },
          {
            // A pane the window holds but whose terminal is still starting (a slow SSH start) stays.
            // Unshown, main takes the pane back; the window's late record may write it again.
            shown: () => {
              const shown =
                this.awaitedSplitLeafIds.get(newLeafId) === true ||
                this.leaves.has(this.getLeafKey(leaf.tabId, newLeafId))
              if (!shown) {
                rememberRecordable(this.recordableSplitLeafIds, newLeafId)
              }
              return shown
            },
            startIfWriteFails: true
          }
        ).finally(() => this.awaitedSplitLeafIds.delete(newLeafId))
        return {
          handle: newHandle,
          tabId: leaf.tabId,
          paneRuntimeId: leaf.paneRuntimeId,
          leafId: newLeafId
        }
      }
    }

    const newLeafId = randomUUID()

    this.notifier?.splitTerminal(leaf.tabId, leaf.paneRuntimeId, {
      direction,
      command: opts.command,
      worktreeId: leaf.worktreeId,
      sourceLeafId: leaf.leafId,
      telemetrySource: opts.telemetrySource,
      newLeafId
    })

    const newHandle = await this.waitForLeafInTab(leaf.tabId, newLeafId)
    return {
      handle: newHandle,
      tabId: leaf.tabId,
      paneRuntimeId: leaf.paneRuntimeId,
      leafId: newLeafId
    }
  }
}

/** Kept only for the newest few: a record comes within one mount of the window. */
function rememberRecordable(recordable: Set<string>, leafId: string): void {
  recordable.add(leafId)
  if (recordable.size > 64) {
    recordable.delete(recordable.values().next().value!)
  }
}
