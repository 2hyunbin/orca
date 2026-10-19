import type { TerminalSplitOptions } from './terminal-split-surface'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import { OrcaRuntimeWithStopExplicitlyClosedTabPtys } from '../../session-tabs/explicit-terminal-close-stops'
import type { TerminalPaneSplitSource } from '../../../../shared/feature-education-telemetry'
import type { RuntimeTerminalSplit } from '../../../../shared/runtime-types'
import { randomUUID } from 'node:crypto'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { admitRuntimePane } from '../../runtime-pane-admission'
import type { RuntimeStore } from '../../runtime-store-contract'
import type { CommandOf } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { collectLeafIds } from '../../../../shared/terminal-pane-layout-tree'

export abstract class OrcaRuntimeWithSplitTerminal extends OrcaRuntimeWithStopExplicitlyClosedTabPtys {
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
        // No pane written, no split: nothing else would put it in main's copy. A pane whose
        // terminal never starts is taken back below, so the CLI's failure is the truth.
        const outcome = await admitRuntimePane(
          this.store,
          {
            type: 'splitPane',
            workspace: leaf.worktreeId,
            tabId: leaf.tabId,
            leafId: leaf.leafId,
            direction,
            newLeafId
          },
          hostId
        )
        if (outcome !== 'admitted' && outcome !== 'exists') {
          throw new Error(`split_not_written: ${outcome ?? 'unknown'}`)
        }
        this.notifier?.splitTerminal(leaf.tabId, leaf.paneRuntimeId, {
          direction,
          command: opts.command,
          worktreeId: leaf.worktreeId,
          sourceLeafId: leaf.leafId,
          telemetrySource: opts.telemetrySource,
          newLeafId
        })
        const newHandle = await settledByPaneClose(
          this.store,
          () => this.getWorkspaceSessionHostIdsForTab(leaf.worktreeId, leaf.tabId),
          leaf.tabId,
          newLeafId,
          this.waitForLeafInTab(leaf.tabId, newLeafId)
        ).catch(async (error: unknown) => {
          if (outcome !== 'admitted' || !isSplitWaitTimeout(error)) {
            throw error
          }
          await takeBackUnstartedSplitPane(this.store, hostId, {
            type: 'closePane',
            workspace: leaf.worktreeId,
            tabId: leaf.tabId,
            leafId: newLeafId
          })
          this.notifier?.closeTerminalPane?.(leaf.tabId, newLeafId)
          throw new Error(
            "split_pane_not_started: the new pane's terminal did not start within 10 s, so the pane was closed"
          )
        })
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

/** Main's own close of the pane settles the wait at once: no terminal will start there. */
function settledByPaneClose(
  store: RuntimeStore | null | undefined,
  hostIds: () => readonly ExecutionHostId[],
  tabId: string,
  leafId: string,
  waiting: Promise<string>
): Promise<string> {
  if (!store?.getWorkspaceSession || !store.onWorkspaceSessionWritten) {
    return waiting
  }
  const getSession = store.getWorkspaceSession.bind(store)
  let stopWatching: (() => void) | undefined
  const closed = new Promise<never>((_resolve, reject) => {
    const check = (): void => {
      const held = hostIds().some((hostId) =>
        collectLeafIds(getSession(hostId)?.terminalLayoutsByTabId?.[tabId]?.root).includes(leafId)
      )
      if (!held) {
        reject(new Error('split_pane_closed'))
      }
    }
    stopWatching = store.onWorkspaceSessionWritten?.(check)
    check()
  })
  return Promise.race([waiting, closed]).finally(() => stopWatching?.())
}

// waitForLeafInTab's timeout (terminal-split-source-authority.ts), shared with the shipped path.
function isSplitWaitTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'Timed out waiting for split pane handle'
}

/** Never the user's close: no launch stops and nothing joins the reopen-closed list. */
async function takeBackUnstartedSplitPane(
  store: RuntimeStore | null | undefined,
  hostId: ExecutionHostId,
  pane: CommandOf<'closePane'>
): Promise<void> {
  try {
    await store?.withdrawTerminalPane?.(pane, hostId)
  } catch (error) {
    console.warn('[layout] an unstarted split pane stayed in main:', error)
  }
}
