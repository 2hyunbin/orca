import type { RuntimeTerminalCreateLaunch } from './terminal-create'
import type { RuntimeTerminalCreateIdentity } from './terminal-create-identity'
import type { WorktreeStartupLaunch } from '../../../../shared/worktree/launch-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session-resume'
import type {
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeTerminalCreate
} from '../../../../shared/runtime-types'
import { randomUUID } from 'node:crypto'
import { copySleepingAgentLaunchConfig } from '../../runtime-agent-launch-resolution'
import { deriveRemoteRuntimeTerminalCreateHandle } from '../../remote-runtime-terminal-create-identity'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import type { Worktree } from '../../../../shared/worktree/types'
import type { PtyIncarnationId } from '../../../../shared/pty-incarnation'
import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'
import type { TerminalHandleRecord } from '../../runtime-terminal-contracts'

export type RuntimeOwnedMobileTerminalOptions = {
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
  supportsSplitGroupPlacement?: boolean
  launchConfig?: SleepingAgentLaunchConfig
  signal?: AbortSignal
  refuseSleptWorktree?: boolean
}

const OWNED_MOBILE_DISPATCH_RECIPE_TTL_MS = 15 * 60_000

export type RuntimeMobileTerminalOwnedCreateHost = {
  resolveTerminalWorkspaceLaunchScope(): (
    selector: string,
    createdWorktree?: Worktree
  ) => Promise<TerminalWorkspaceLaunchScope>
  resolveWorkspaceTerminalStartupCwd(): (
    workspace: Pick<TerminalWorkspaceLaunchScope, 'path'>,
    requestedCwd?: string | null
  ) => string | undefined
  createTerminal(): RuntimeTerminalCreateLaunch['createTerminal']
  dedupeTerminalCreate(): RuntimeTerminalCreateIdentity['dedupeTerminalCreate']
  getLivePtyForHandle(): (handle: string) => {
    record: TerminalHandleRecord
    pty: RuntimePtyWorktreeRecord
  } | null
  registerPty(): (
    ptyId: string,
    worktreeId: string,
    connectionId?: string | null,
    binding?: {
      tabId: string
      leafId: string
      incarnationId?: PtyIncarnationId
      /** Handle allocated for the replacement incarnation, when one is known. */
      terminalHandle?: string
      agentLaunchAuthority?: { launchToken: string; launchAgent: TuiAgent }
      providerReattachLaunchIdentity?: {
        incarnationId: PtyIncarnationId
        launchAgent: TuiAgent
      }
    },
    isWsl?: boolean
  ) => void
  publishRuntimeOwnedMobileSessionTerminal(): (
    worktreeId: string,
    activate: boolean,
    afterTabId: string | undefined,
    opts: RuntimeOwnedMobileTerminalOptions,
    cwd: string | undefined,
    terminal: RuntimeTerminalCreate,
    livePty: { pty: RuntimePtyWorktreeRecord }
  ) => RuntimeMobileSessionCreateTerminalResult
}

export class RuntimeMobileTerminalOwnedCreate {
  private readonly ownedMobileDispatchRecipes = new Map<
    string,
    {
      launchConfig?: SleepingAgentLaunchConfig
      launchAgent?: TuiAgent
      connectionId: string | null
      recordedAt: number
    }
  >()
  constructor(private readonly host: RuntimeMobileTerminalOwnedCreateHost) {}
  private pruneOwnedMobileDispatchRecipes(): void {
    const now = Date.now()
    for (const [handle, recipe] of this.ownedMobileDispatchRecipes) {
      if (now - recipe.recordedAt >= OWNED_MOBILE_DISPATCH_RECIPE_TTL_MS) {
        this.ownedMobileDispatchRecipes.delete(handle)
      }
    }
  }

  async createRuntimeOwnedMobileSessionTerminal(
    worktreeId: string,
    activate: boolean,
    afterTabId?: string,
    opts: RuntimeOwnedMobileTerminalOptions = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    this.pruneOwnedMobileDispatchRecipes()
    const workspace = await this.host.resolveTerminalWorkspaceLaunchScope()(`id:${worktreeId}`)
    const cwd = this.host.resolveWorkspaceTerminalStartupCwd()(workspace, opts.cwd)
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
    const create = (preAllocatedHandle?: string) =>
      this.host.createTerminal()(`id:${worktreeId}`, {
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
        ...(opts.targetGroupId ? { targetGroupId: opts.targetGroupId } : {}),
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
        // Why: this method publishes the authoritative snapshot below; skip the intermediate publish to avoid a wrong-group flash.
        deferMobileSessionPublish: true,
        signal: opts.signal,
        ...(opts.refuseSleptWorktree ? { refuseSleptWorktree: true } : {})
      })
    const terminal = opts.createMutation
      ? await this.host.dedupeTerminalCreate()(
          opts.createMutation.clientIdentity,
          `id:${worktreeId}`,
          opts.createMutation.id,
          true,
          (_selector, handle) => create(handle)
        )
      : await create()
    const livePty = this.host.getLivePtyForHandle()(terminal.handle)
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
      this.host.registerPty()(terminal.ptyId, worktreeId, workspace.connectionId ?? null, {
        tabId: opts.identity.tabId,
        leafId: opts.identity.leafId,
        terminalHandle: terminal.handle
      })
    }
    return this.host.publishRuntimeOwnedMobileSessionTerminal()(
      worktreeId,
      activate,
      afterTabId,
      opts,
      cwd,
      terminal,
      livePty
    )
  }
}
