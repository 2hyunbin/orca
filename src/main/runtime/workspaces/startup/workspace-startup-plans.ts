import { OrcaRuntimeWithListManagedWorktrees } from '../../orca-runtime-list-managed-worktrees'
import type { Repo } from '../../../../shared/repo-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { WorktreeStartupLaunch } from '../../../../shared/worktree/launch-types'
import type {
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from '../../runtime-worktree-agent-startup'
import {
  buildWorktreeStartupForAgent,
  buildWorktreeStartupForDraft,
  resolveWorktreeStartupDraftAgent
} from '../../runtime-worktree-agent-startup'
import type { AgentLaunchPreferences } from '../../../../shared/agent-session-host-authority'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeLineageResolution } from '../../runtime-worktree-lineage-resolution'
import type {
  WorkspaceLineage,
  WorktreeLineage,
  WorktreeLineageWarning
} from '../../../../shared/worktree/lineage-types'
import { recordCreatedWorktreeLineage as recordCreatedWorktreeLineageState } from '../../runtime-worktree-lineage-recording'
import type { OrcaRuntimeWithGetAgentSessionExecutionNamespace } from '../../orca-runtime-get-agent-session-execution-namespace'

export abstract class RuntimeWorktreeStartupPlans extends OrcaRuntimeWithListManagedWorktrees {
  protected abstract toAgentSessionOptions(
    ...args: Parameters<OrcaRuntimeWithGetAgentSessionExecutionNamespace['toAgentSessionOptions']>
  ): ReturnType<OrcaRuntimeWithGetAgentSessionExecutionNamespace['toAgentSessionOptions']>

  /** The agent a create's linked draft starts, chosen as `buildStartupForDraft` chooses it, so a
   *  launch can name the agent before the create runs. */
  async resolveStartupDraftAgent(repo: Repo, requestedAgent?: TuiAgent): Promise<TuiAgent | null> {
    if (!this.store) {
      return null
    }
    return resolveWorktreeStartupDraftAgent({
      repo,
      settings: this.store.getSettings(),
      ...(requestedAgent ? { requestedAgent } : {})
    })
  }

  protected async buildStartupForDraft(
    repo: Repo,
    draft: string,
    requestedAgent?: TuiAgent,
    launchSource?: string
  ): Promise<{
    agent: TuiAgent
    startup: WorktreeStartupLaunch
    draftPaste?: WorktreeStartupDraftPaste
  } | null> {
    if (!this.store) {
      return null
    }
    return buildWorktreeStartupForDraft({
      repo,
      draft,
      ...(requestedAgent ? { requestedAgent } : {}),
      ...(launchSource ? { launchSource } : {}),
      settings: this.store.getSettings(),
      getLaunchPlatform: () => this.getAgentLaunchPlatformForRepo(repo)
    })
  }

  protected buildStartupForAgent(
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
  ): { agent: TuiAgent; startup: WorktreeStartupLaunch; followup?: WorktreeStartupFollowup } {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    return buildWorktreeStartupForAgent({
      repo,
      agent,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(launchPreferences ? { launchPreferences } : {}),
      ...(launchInputs?.agentArgs !== undefined ? { agentArgs: launchInputs.agentArgs } : {}),
      ...(launchInputs?.extraAgentArgs ? { extraAgentArgs: launchInputs.extraAgentArgs } : {}),
      ...(launchInputs?.launchSource ? { launchSource: launchInputs.launchSource } : {}),
      ...(launchInputs?.onPromptCarry ? { onPromptCarry: launchInputs.onPromptCarry } : {}),
      settings: this.store.getSettings(),
      getLaunchPlatform: () => this.getAgentLaunchPlatformForRepo(repo),
      toSessionOptions: (preferences) => this.toAgentSessionOptions(preferences)
    })
  }

  protected recordCreatedWorktreeLineage(
    worktree: Pick<Worktree, 'id' | 'instanceId'>,
    lineageResolution: WorktreeLineageResolution
  ): {
    lineage: WorktreeLineage | null
    workspaceLineage: WorkspaceLineage | null
    warnings: WorktreeLineageWarning[]
  } {
    return recordCreatedWorktreeLineageState(this.store, worktree, lineageResolution)
  }
}
