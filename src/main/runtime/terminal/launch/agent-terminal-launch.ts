import type { RuntimeTerminalCreateLaunch } from './terminal-create'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-types'
import { resolveWorktreeLaunchHost } from '../../worktree-launch-host-repo'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { Repo } from '../../../../shared/repo-types'
import type { RuntimeStore } from '../../runtime-store-contract'
import type { RuntimeWorkspaceSelectors } from '../../workspaces/workspace-selectors'
import type { WorktreeStartupLaunch } from '../../../../shared/worktree/launch-types'
import type { WorktreeStartupFollowup } from '../../runtime-worktree-agent-startup'
import type { AgentLaunchPreferences } from '../../../../shared/agent-session-host-authority'

export type RuntimeAgentTerminalLaunchHost = {
  resolveWorktreeSelector(): (
    ...args: Parameters<RuntimeWorkspaceSelectors['resolveWorktreeSelector']>
  ) => ReturnType<RuntimeWorkspaceSelectors['resolveWorktreeSelector']>
  getStore(): Pick<RuntimeStore, 'getRepos' | 'getRepo'> | null
  buildStartupForAgent(): (
    repo: Repo,
    agent: TuiAgent,
    prompt: string | undefined,
    launchPreferences?: AgentLaunchPreferences,
    launchInputs?: {
      agentArgs?: string | null
      extraAgentArgs?: string
      launchSource?: string
      onPromptCarry?: (carried: boolean) => void
    }
  ) => { agent: TuiAgent; startup: WorktreeStartupLaunch; followup?: WorktreeStartupFollowup }
  createTerminal(): RuntimeTerminalCreateLaunch['createTerminal']
  sendStartupFollowupWhenReady(): (handle: string, followup: WorktreeStartupFollowup) => void
}

export class RuntimeAgentTerminalLaunch {
  constructor(private readonly host: RuntimeAgentTerminalLaunchHost) {}
  private get store() {
    return this.host.getStore()
  }
  async launchAgentTerminal(
    worktreeSelector: string,
    opts: { agent: TuiAgent; prompt: string; title?: string; extraAgentArgs?: string }
  ): Promise<RuntimeTerminalCreate> {
    const worktree = await this.host.resolveWorktreeSelector()(worktreeSelector)
    // Why: `getRepo(id)` is host-blind; the same repo id on two hosts must build the launch for the
    // host that owns this worktree (#11163).
    const resolution = resolveWorktreeLaunchHost(this.store?.getRepos() ?? [], worktree)
    if (resolution.kind === 'ambiguous') {
      throw new Error('worktree_execution_host_unresolved')
    }
    const repo = resolution.repo ?? this.store?.getRepo(worktree.repoId)
    if (!repo) {
      throw new Error('Repository for the selected workspace is no longer available.')
    }
    const startup = this.host.buildStartupForAgent()(
      repo,
      opts.agent,
      opts.prompt,
      undefined,
      opts.extraAgentArgs ? { extraAgentArgs: opts.extraAgentArgs } : undefined
    )
    const terminal = await this.host.createTerminal()(`id:${worktree.id}`, {
      command: startup.startup.command,
      env: startup.startup.env,
      ...(startup.startup.launchConfig ? { launchConfig: startup.startup.launchConfig } : {}),
      launchAgent: startup.agent,
      startupCommandDelivery: startup.startup.startupCommandDelivery,
      telemetry: startup.startup.telemetry,
      title: opts.title
    })
    // Why: agents that read the prompt after they start get it typed in, not on argv.
    if (startup.followup) {
      this.host.sendStartupFollowupWhenReady()(terminal.handle, startup.followup)
    }
    return terminal
  }
}
