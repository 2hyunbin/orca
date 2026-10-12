import type { TerminalPaneSplitSource } from '../../../../shared/feature-education-telemetry'
import type { RuntimeTerminalSplit } from '../../../../shared/runtime-types'
import { randomUUID } from 'node:crypto'
import type { Worktree } from '../../../../shared/worktree/types'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import { makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { recordPtySurface, spawnSurfaceClaimSequence } from '../../pty-recorded-surface-topology'
import { runtimeSplitPlacement } from '../../runtime-terminal-spawn-placement'
import { REJECTED_SPLIT_PTY_STOP_TIMEOUT_MS, ownerSurfacing } from '../../orca-runtime-core'
import { type spawnInAdmittedPane, withdrawRuntimePane } from '../../runtime-pane-admission'
import type { RuntimeTerminalSplitLaunchHost } from './terminal-split-host'

export class RuntimeTerminalSplitLaunch {
  constructor(private readonly host: RuntimeTerminalSplitLaunchHost) {}
  private get notifier() {
    return this.host.getNotifier()
  }
  private get ptyController() {
    return this.host.getPtyController()
  }
  private get store() {
    return this.host.getStore()
  }
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
    const livePty = this.host.getLivePtyForHandle()(handle)
    if (livePty) {
      return await this.host.splitPtyBackedTerminal()(livePty.pty, opts, createdWorktree)
    }
    this.host.assertGraphReady()()
    const { leaf } = this.host.getLiveLeafForHandle()(handle)
    const direction = opts.direction ?? 'horizontal'

    const newLeafId = randomUUID()

    this.notifier?.splitTerminal(leaf.tabId, leaf.paneRuntimeId, {
      direction,
      command: opts.command,
      worktreeId: leaf.worktreeId,
      sourceLeafId: leaf.leafId,
      telemetrySource: opts.telemetrySource,
      newLeafId
    })

    const newHandle = await this.host.waitForLeafInTab()(leaf.tabId, newLeafId)
    return {
      handle: newHandle,
      tabId: leaf.tabId,
      paneRuntimeId: leaf.paneRuntimeId,
      leafId: newLeafId
    }
  }

  async splitPtyBackedTerminal(
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
    const workspace = await this.host.resolveTerminalWorkspaceLaunchScope()(
      `id:${pty.worktreeId}`,
      createdWorktree
    )
    const sourceAuthority = this.host.resolveTerminalSplitSourceAuthority()(
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
    const preAllocatedHandle = this.host.createPreAllocatedTerminalHandle()()
    const paneKey = makePaneKey(parentTabId, leafId)
    const splitArgs: Parameters<typeof spawnInAdmittedPane>[2] = {
      cols: 120,
      rows: 40,
      cwd: workspace.path,
      command: opts.command,
      commandDelivery: 'provider',
      env: await this.host.buildTerminalWorkspaceEnv()(
        workspace,
        opts.env ?? {},
        paneKey,
        parentTabId
      ),
      envToDelete: opts.envToDelete,
      connectionId: workspace.connectionId,
      worktreeId: workspace.id,
      preAllocatedHandle,
      tabId: parentTabId,
      leafId,
      persistHostSessionBinding: true,
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
    const result = await this.host.spawnInAdmittedPane()(splitArgs)
    this.host.registerPreAllocatedHandleForPty()(result.id, preAllocatedHandle)
    if (result.wslDistro) {
      this.host.preparePtyExecutionContext()(result.id, result.wslDistro)
    }
    this.host.registerPty()(result.id, workspace.id, workspace.connectionId)
    const createdPty = this.host.getOrCreatePtyWorktreeRecord()(result.id)
    if (createdPty) {
      recordPtySurface(
        createdPty,
        parentTabId,
        paneKey,
        spawnSurfaceClaimSequence(this.host.getGraphSequence())
      )
      createdPty.runtimeSessionOwned = pty.runtimeSessionOwned
      this.host.setPairedRendererSessionOwnership()(
        createdPty.ptyId,
        this.host.getPairedRendererSessionOwnedPtyIds().has(pty.ptyId)
      )
    }

    const revealSplit = async (): Promise<void> => {
      await this.notifier?.revealTerminalSession?.(workspace.id, {
        ptyId: result.id,
        title: null,
        activate: opts.activate !== false,
        ...ownerSurfacing(opts.surfaceOwner !== false),
        tabId: parentTabId,
        leafId,
        splitFromLeafId: parsedPaneKey.leafId,
        splitDirection: direction,
        splitTelemetrySource: opts.telemetrySource
      })
    }

    try {
      const revalidateSourceAuthority = (): void => {
        const current = this.host.resolveTerminalSplitSourceAuthority()(
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
      if (!sourceAuthority.persisted) {
        await revealSplit()
        // Why: rejecting here unmounts the pane the reveal just added only because the retire
        // below always emits its exit and the tab still holds the source sibling — the renderer's
        // exit handler closes non-final panes. Never close it by tabId: that drops the whole tab.
        revalidateSourceAuthority()
      }
      if (createdPty) {
        this.host.publishPtyBackedMobileSessionTerminal()(workspace.id, createdPty, {
          tabId: parentTabId,
          leafId,
          title: null,
          activate: opts.activate !== false,
          split: { splitFromLeafId: parsedPaneKey.leafId, direction }
        })
      }
    } catch (error) {
      this.host.setPairedRendererSessionOwnership()(result.id, false)
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
      await withdrawRuntimePane(this.store, splitArgs)
      throw error
    }
    const committedSourceAuthority = sourceAuthority.persisted
      ? this.host.resolveTerminalSplitSourceAuthority()(
          workspace.id,
          parentTabId,
          parsedPaneKey.leafId,
          pty.ptyId
        )
      : null
    if (sourceAuthority.persisted && committedSourceAuthority?.rendererMounted) {
      // Why: renderer adoption is a projection after the durable main commit; rejection cannot undo it.
      void revealSplit().catch(() => undefined)
    }

    return {
      handle: this.host.issuePtyHandle()(createdPty ?? pty),
      tabId: parentTabId,
      paneRuntimeId: -1,
      leafId
    }
  }
}
