// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithResolveMobileSessionTerminalCommand } from './orca-runtime-resolve-mobile-session-terminal-command'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../shared/runtime-types'
import { randomUUID } from 'node:crypto'
import { copySleepingAgentLaunchConfig } from './runtime-agent-launch-resolution'
import { deriveRemoteRuntimeTerminalCreateHandle } from './remote-runtime-terminal-create-identity'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { translateCreateTerminalTab } from '../../shared/workspace-layout/old-client'

const OWNED_MOBILE_DISPATCH_RECIPE_TTL_MS = 15 * 60_000

export class OrcaRuntimeWithCreateRuntimeOwnedMobileSessionTerminal extends OrcaRuntimeWithResolveMobileSessionTerminalCommand {
  private readonly ownedMobileDispatchRecipes = new Map<
    string,
    {
      launchConfig?: SleepingAgentLaunchConfig
      launchAgent?: TuiAgent
      connectionId: string | null
      recordedAt: number
    }
  >()

  private pruneOwnedMobileDispatchRecipes(): void {
    const now = Date.now()
    for (const [handle, recipe] of this.ownedMobileDispatchRecipes) {
      if (now - recipe.recordedAt >= OWNED_MOBILE_DISPATCH_RECIPE_TTL_MS) {
        this.ownedMobileDispatchRecipes.delete(handle)
      }
    }
  }

  protected async createRuntimeOwnedMobileSessionTerminal(
    worktreeId: string,
    activate: boolean,
    afterTabId?: string,
    opts: {
      command?: string
      cwd?: string
      env?: Record<string, string>
      envToDelete?: string[]
      startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
      identity?: { tabId: string; leafId: string; sessionId?: string }
      createMutation?: { clientIdentity: string; id: string }
      launchAgent?: TuiAgent
      viewMode?: 'terminal' | 'chat'
      targetGroupId?: string
      launchConfig?: SleepingAgentLaunchConfig
      signal?: AbortSignal
      refuseSleptWorktree?: boolean
    } = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    this.pruneOwnedMobileDispatchRecipes()
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
    const cwd = this.resolveWorkspaceTerminalStartupCwd(workspace, opts.cwd)
    // Why: an SSH sessionId means reattach; only synthesize local serve ids so SSH fresh terminals still call pty.spawn.
    const stableSessionId =
      opts.identity?.sessionId ?? (workspace.connectionId ? undefined : `serve-${randomUUID()}`)
    const isNewSession = stableSessionId !== undefined && opts.identity?.sessionId === undefined
    const mutationHandle = opts.createMutation
      ? deriveRemoteRuntimeTerminalCreateHandle(
          opts.createMutation.clientIdentity,
          worktreeId,
          opts.createMutation.id
        )
      : undefined
    // `session.tabs.createTerminal`'s placement, as the holder's create places it.
    const translated = translateCreateTerminalTab(
      worktreeId,
      this.heldWorkspaceLayout(worktreeId),
      {
        ...(afterTabId ? { afterTabId } : {}),
        ...(opts.targetGroupId ? { targetGroupId: opts.targetGroupId } : {})
      }
    )
    const placement =
      translated.ok && translated.commands[0]?.type === 'createTerminalTab'
        ? translated.commands[0]
        : null
    const create = (preAllocatedHandle?: string) =>
      this.createTerminal(`id:${worktreeId}`, {
        focus: false,
        ...(mutationHandle
          ? {
              onPtySpawnDispatched: (launch) => {
                if (!launch) {
                  return
                }
                if (
                  !this.ownedMobileDispatchRecipes.has(mutationHandle) &&
                  this.ownedMobileDispatchRecipes.size >= 4096
                ) {
                  throw new Error('runtime_unavailable')
                }
                // Retain original dispatch evidence across an ambiguous response; retry payloads cannot replace it.
                this.ownedMobileDispatchRecipes.set(mutationHandle, {
                  connectionId: workspace.connectionId ?? null,
                  recordedAt: Date.now(),
                  ...(launch.launchConfig
                    ? { launchConfig: copySleepingAgentLaunchConfig(launch.launchConfig) }
                    : {}),
                  ...(launch.launchAgent ? { launchAgent: launch.launchAgent } : {})
                })
              }
            }
          : {}),
        ...(preAllocatedHandle ? { preAllocatedHandle } : {}),
        command: opts.command,
        cwd,
        env: opts.env,
        envToDelete: opts.envToDelete,
        ...(opts.launchConfig ? { launchConfig: opts.launchConfig } : {}),
        ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {}),
        ...(opts.viewMode ? { viewMode: opts.viewMode } : {}),
        ...(placement?.groupId ? { targetGroupId: placement.groupId } : {}),
        ...(placement?.afterTabId ? { afterTabId: placement.afterTabId } : {}),
        startupCommandDelivery: opts.startupCommandDelivery,
        ...(opts.identity
          ? {
              tabId: opts.identity.tabId,
              leafId: opts.identity.leafId,
              ...(stableSessionId ? { sessionId: stableSessionId } : {})
            }
          : stableSessionId
            ? { sessionId: stableSessionId }
            : {}),
        ...(isNewSession ? { isNewSession: true } : {}),
        persistHostSessionBinding: true,
        signal: opts.signal,
        ...(opts.refuseSleptWorktree ? { refuseSleptWorktree: true } : {})
      })
    const terminal = opts.createMutation
      ? await this.dedupeTerminalCreate(
          opts.createMutation.clientIdentity,
          `id:${worktreeId}`,
          opts.createMutation.id,
          true,
          (_selector, handle) => create(handle)
        )
      : await create()
    const livePty = this.getLivePtyForHandle(terminal.handle)
    if (!livePty) {
      throw new Error('terminal_handle_stale')
    }
    if (opts.createMutation) {
      if (
        livePty.pty.launchAgent &&
        opts.launchAgent &&
        livePty.pty.launchAgent !== opts.launchAgent
      ) {
        throw new Error('terminal_create_identity_conflict')
      }
      const dispatchedRecipe =
        mutationHandle === terminal.handle && this.ownedMobileDispatchRecipes.get(terminal.handle)
      const recipe =
        dispatchedRecipe &&
        dispatchedRecipe.connectionId === (workspace.connectionId ?? null) &&
        (!livePty.pty.launchAgent || livePty.pty.launchAgent === dispatchedRecipe.launchAgent)
          ? dispatchedRecipe
          : null
      if (opts.launchConfig && !livePty.pty.launchConfig && !recipe?.launchConfig) {
        // Missing original dispatch evidence cannot authorize a retry's captured recipe.
        throw new Error('runtime_unavailable')
      }
      if (recipe) {
        livePty.pty.launchAgent ??= recipe.launchAgent ?? null
        if (!livePty.pty.launchConfig && recipe.launchConfig) {
          livePty.pty.launchConfig = copySleepingAgentLaunchConfig(recipe.launchConfig)
        }
      }
      livePty.pty.runtimeSessionOwned = true
      if (mutationHandle) {
        this.ownedMobileDispatchRecipes.delete(mutationHandle)
      }
    }
    if (opts.createMutation && opts.identity && terminal.ptyId) {
      this.registerPty(terminal.ptyId, worktreeId, workspace.connectionId ?? null, {
        tabId: opts.identity.tabId,
        leafId: opts.identity.leafId,
        terminalHandle: terminal.handle
      })
    }
    const parentTabId = livePty.pty.tabId ?? `pty:${livePty.pty.ptyId}`
    const leafId = parsePaneKey(livePty.pty.paneKey ?? '')?.leafId
    const heldTab = () =>
      this.heldWorkspaceLayout(worktreeId)?.tabs.find(
        (tab) => tab.kind === 'terminal' && tab.entityId === parentTabId
      )
    if (!heldTab() && leafId) {
      // A retry found the terminal its first, ambiguous attempt started after that pane was taken back.
      this.admitRecoveredTerminal(worktreeId, livePty.pty, {
        ...(placement?.groupId ? { groupId: placement.groupId } : {}),
        ...(placement?.afterTabId ? { afterTabId: placement.afterTabId } : {})
      })
    }
    const held = heldTab()
    if (activate && held) {
      // The desktop goes to the phone's new terminal, as main's window did.
      this.navigateDesktopView(worktreeId, { tabId: held.id, ...(leafId ? { leafId } : {}) })
    }
    const result = this.getMobileSessionTabsForWorktree(worktreeId)
    const created = result.tabs.find(
      (candidate) =>
        candidate.type === 'terminal' &&
        candidate.parentTabId === parentTabId &&
        candidate.leafId === leafId
    )
    if (!created || created.type !== 'terminal') {
      throw new Error('terminal_handle_stale')
    }
    return {
      tab: created,
      publicationEpoch: result.publicationEpoch,
      snapshotVersion: result.snapshotVersion
    }
  }
}
