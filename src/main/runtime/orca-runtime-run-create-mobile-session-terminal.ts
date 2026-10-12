// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithCreateMobileSessionTerminal } from './orca-runtime-create-mobile-session-terminal'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../shared/runtime-types'
import { deterministicAgentSessionUuid } from './runtime-agent-launch-resolution'

export class OrcaRuntimeWithRunCreateMobileSessionTerminal extends OrcaRuntimeWithCreateMobileSessionTerminal {
  protected async runCreateMobileSessionTerminal(
    worktreeSelector: string,
    opts: {
      afterTabId?: string
      targetGroupId?: string
      command?: string
      cwd?: string
      env?: Record<string, string>
      envToDelete?: string[]
      startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
      agent?: TuiAgent
      agentPrompt?: string
      launchConfig?: SleepingAgentLaunchConfig
      launchAgent?: TuiAgent
      viewMode?: 'terminal' | 'chat'
      activate?: boolean
      clientNavigationId?: string
      clientMutationId?: string
      supportsSplitGroupPlacement?: boolean
      signal?: AbortSignal
    } = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    const graphEpoch = this.captureReadyGraphEpoch()
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(worktreeSelector)
    const worktreeId = workspace.id
    const cwd = this.resolveWorkspaceTerminalStartupCwd(workspace, opts.cwd)
    // Older mobile clients append their optimistic tab, so make the host append too until the
    // client advertises the grouped placement contract.
    const requestedAfterTabId = opts.afterTabId
    const afterTabId =
      opts.clientNavigationId && opts.supportsSplitGroupPlacement === false
        ? undefined
        : requestedAfterTabId
    if (
      requestedAfterTabId &&
      !this.readSessionTabsSnapshot(worktreeId)?.tabs.some((tab) => tab.id === requestedAfterTabId)
    ) {
      throw new Error('after_tab_not_found')
    }
    const startupCommand = await this.resolveMobileSessionTerminalCommand(workspace, opts)
    this.assertStableReadyGraph(graphEpoch)
    if (opts.signal?.aborted) {
      throw new Error('client_disconnected')
    }
    if (opts.clientMutationId && startupCommand.command && startupCommand.launchAgent === 'qoder') {
      const clientIdentity = opts.clientNavigationId ?? 'local'
      const seed = `${clientIdentity}\0${worktreeId}\0${opts.clientMutationId}`
      // A command-bearing retry must reconcile the owning PTY before delivering the resume again.
      return await this.createRuntimeOwnedMobileSessionTerminal(
        worktreeId,
        opts.activate !== false,
        afterTabId,
        {
          ...startupCommand,
          cwd,
          identity: {
            tabId: deterministicAgentSessionUuid(`mobile-qoder-tab\0${seed}`),
            leafId: deterministicAgentSessionUuid(`mobile-qoder-leaf\0${seed}`)
          },
          createMutation: { clientIdentity, id: opts.clientMutationId },
          viewMode: opts.viewMode,
          targetGroupId: opts.targetGroupId,
          signal: opts.signal
        }
      )
    }
    return await this.createRuntimeOwnedMobileSessionTerminal(
      worktreeId,
      opts.activate !== false,
      afterTabId,
      {
        command: startupCommand.command,
        cwd,
        env: startupCommand.env,
        envToDelete: startupCommand.envToDelete,
        startupCommandDelivery: startupCommand.startupCommandDelivery,
        launchAgent: startupCommand.launchAgent,
        viewMode: opts.viewMode,
        targetGroupId: opts.targetGroupId,
        launchConfig: startupCommand.launchConfig,
        signal: opts.signal
      }
    )
  }
}
