// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithSplitTerminal } from './orca-runtime-split-terminal'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { TerminalPaneSplitSource } from '../../shared/feature-education-telemetry'
import type { RuntimeTerminalSplit } from '../../shared/runtime-types'
import { makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import { recordPtySurface, spawnSurfaceClaimSequence } from './pty-recorded-surface-topology'
import { randomUUID } from 'node:crypto'
import { runtimeSplitPlacement } from './runtime-terminal-spawn-placement'
import { REJECTED_SPLIT_PTY_STOP_TIMEOUT_MS } from './orca-runtime-core'
import type { Worktree } from '../../shared/worktree/types'
import { spawnInAdmittedPane, withdrawRuntimePane } from './runtime-pane-admission'

export class OrcaRuntimeWithSplitPtyBackedTerminal extends OrcaRuntimeWithSplitTerminal {
  protected async splitPtyBackedTerminal(
    pty: RuntimePtyWorktreeRecord,
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
    createdWorktree?: Worktree
  ): Promise<RuntimeTerminalSplit> {
    if (!this.ptyController?.spawn) {
      throw new Error('runtime_unavailable')
    }
    if (!pty.connected) {
      throw new Error('terminal_exited')
    }
    const parsedPaneKey = parsePaneKey(pty.paneKey ?? '')
    const parentTabId = pty.tabId?.trim()
    if (!parentTabId || !parsedPaneKey) {
      throw new Error('terminal_handle_stale')
    }
    const direction = opts.direction ?? 'horizontal'
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(
      `id:${pty.worktreeId}`,
      createdWorktree
    )
    const sourceAuthority = this.resolveTerminalSplitSourceAuthority(
      workspace.id,
      parentTabId,
      parsedPaneKey.leafId,
      pty.ptyId
    )
    if (!sourceAuthority) {
      throw new Error('terminal_split_source_not_found')
    }
    const sourceIncarnationId =
      sourceAuthority.liveIncarnationId ?? sourceAuthority.persistedIncarnationId
    const leafId = randomUUID()
    const preAllocatedHandle = this.createPreAllocatedTerminalHandle()
    const paneKey = makePaneKey(parentTabId, leafId)
    const splitArgs = {
      cols: 120,
      rows: 40,
      cwd: workspace.path,
      command: opts.command,
      commandDelivery: 'provider',
      env: await this.buildTerminalWorkspaceEnv(workspace, opts.env ?? {}, paneKey, parentTabId),
      envToDelete: opts.envToDelete,
      connectionId: workspace.connectionId,
      worktreeId: workspace.id,
      preAllocatedHandle,
      tabId: parentTabId,
      leafId,
      runtimeAdmittedPane: true,
      placement: runtimeSplitPlacement(parsedPaneKey.leafId, direction),
      ...(sourceAuthority.persisted
        ? {
            expectedSourceBinding: {
              ...(sourceAuthority.persistedWorktreeId
                ? { worktreeId: sourceAuthority.persistedWorktreeId }
                : {}),
              tabId: parentTabId,
              leafId: parsedPaneKey.leafId,
              ptyId: pty.ptyId,
              // Why: the store can only match its own persisted map, so a live-only id it never
              // recorded would reject every split from a session restored without incarnations.
              // The live id is fenced by revalidateSourceAuthority below instead.
              ...(sourceAuthority.persistedIncarnationId
                ? { incarnationId: sourceAuthority.persistedIncarnationId }
                : {})
            }
          }
        : {})
    }
    const result = await spawnInAdmittedPane(this.layoutHolder, this.ptyController, splitArgs)
    this.registerPreAllocatedHandleForPty(result.id, preAllocatedHandle)
    if (result.wslDistro) {
      this.preparePtyExecutionContext(result.id, result.wslDistro)
    }
    this.registerPty(result.id, workspace.id, workspace.connectionId)
    const createdPty = this.getOrCreatePtyWorktreeRecord(result.id)
    if (createdPty) {
      recordPtySurface(
        createdPty,
        parentTabId,
        paneKey,
        spawnSurfaceClaimSequence(this.graphSequence)
      )
      createdPty.runtimeSessionOwned = pty.runtimeSessionOwned
      this.setPairedRendererSessionOwnership(
        createdPty.ptyId,
        this.pairedRendererSessionOwnedPtyIds.has(pty.ptyId)
      )
    }

    try {
      const revalidateSourceAuthority = (): void => {
        const current = this.resolveTerminalSplitSourceAuthority(
          workspace.id,
          parentTabId,
          parsedPaneKey.leafId,
          pty.ptyId
        )
        if (
          !current ||
          (sourceAuthority.persisted && !current.persisted) ||
          (sourceIncarnationId !== null &&
            (current.liveIncarnationId ?? current.persistedIncarnationId) !== sourceIncarnationId)
        ) {
          throw new Error('terminal_split_source_not_found')
        }
      }
      revalidateSourceAuthority()
    } catch (error) {
      this.setPairedRendererSessionOwnership(result.id, false)
      let stopped = false
      try {
        stopped =
          (await this.ptyController.stopAndWait?.(result.id, {
            deadlineMs: Date.now() + REJECTED_SPLIT_PTY_STOP_TIMEOUT_MS
          })) ?? false
      } catch {
        // Best-effort fallback below preserves the original split authority error.
      }
      if (!stopped) {
        try {
          this.ptyController.kill(result.id)
        } catch {
          // Best-effort cleanup; retirement below still runs and the original error still throws.
        }
      }
      try {
        this.ptyController.retireRejectedPty?.(result.id, stopped)
      } catch {
        // Best-effort cleanup; preserve the original split authority error.
      }
      withdrawRuntimePane(this.layoutHolder, splitArgs)
      throw error
    }
    if (opts.activate !== false && opts.surfaceOwner !== false) {
      this.focusHeldTerminalInDesktopView(
        { worktreeId: workspace.id, tabId: parentTabId, paneKey },
        { navigate: true }
      )
    }
    return {
      handle: this.issuePtyHandle(createdPty ?? pty),
      tabId: parentTabId,
      paneRuntimeId: -1,
      leafId
    }
  }
}
