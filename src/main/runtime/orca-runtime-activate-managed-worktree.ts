import type { RuntimeWorkspaceActivation } from './workspaces/workspace-activation'

import type { TuiAgent } from '../../shared/tui-agent'
import type { RuntimeTerminalWait } from '../../shared/runtime-terminal-contracts'
import type {
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from './runtime-worktree-agent-startup'
import type { Worktree } from '../../shared/worktree/types'
import {
  deliverWorktreeStartupFollowup,
  pasteWorktreeStartupDraftWhenReady,
  sendWorktreeStartupFollowupWhenReady,
  waitForWorktreeStartupDraft
} from './runtime-worktree-startup-readiness'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import { provisionWorktreeTerminals } from './runtime-worktree-terminal-provisioning'
import { readFreshComposerHold } from './launched-agent-composer-readiness'
import { buildTerminalWaitText } from './terminal-wait-tail-state'
import {
  readLaunchedAgentForeground,
  type LaunchedAgentForeground
} from './launched-agent-foreground'
import { RuntimeWorktreeStartupPlans } from './workspaces/startup/workspace-startup-plans'
import type { OrcaRuntimeWithBuildPtyTerminalSummary } from './orca-runtime-build-pty-terminal-summary'
import type { OrcaRuntimeWithResolveWaiter } from './orca-runtime-resolve-waiter'
import type { OrcaRuntimeWithGetWorktreeTerminalProvisioningHost } from './orca-runtime-get-worktree-terminal-provisioning-host'

export abstract class OrcaRuntimeWithActivateManagedWorktree extends RuntimeWorktreeStartupPlans {
  protected abstract getWorktreeStartupReadinessHost(
    ...args: Parameters<
      OrcaRuntimeWithGetWorktreeTerminalProvisioningHost['getWorktreeStartupReadinessHost']
    >
  ): ReturnType<
    OrcaRuntimeWithGetWorktreeTerminalProvisioningHost['getWorktreeStartupReadinessHost']
  >
  protected abstract assertLiveTerminalHandleTargetsPty(
    ...args: Parameters<
      OrcaRuntimeWithBuildPtyTerminalSummary['assertLiveTerminalHandleTargetsPty']
    >
  ): ReturnType<OrcaRuntimeWithBuildPtyTerminalSummary['assertLiveTerminalHandleTargetsPty']>

  protected abstract getAvailableAuthoritativeWindow(
    ...args: Parameters<OrcaRuntimeWithResolveWaiter['getAvailableAuthoritativeWindow']>
  ): ReturnType<OrcaRuntimeWithResolveWaiter['getAvailableAuthoritativeWindow']>

  protected abstract getWorktreeTerminalProvisioningHost(
    ...args: Parameters<
      OrcaRuntimeWithGetWorktreeTerminalProvisioningHost['getWorktreeTerminalProvisioningHost']
    >
  ): ReturnType<
    OrcaRuntimeWithGetWorktreeTerminalProvisioningHost['getWorktreeTerminalProvisioningHost']
  >
  activateManagedWorktree(
    ...args: Parameters<RuntimeWorkspaceActivation['activateManagedWorktree']>
  ): ReturnType<RuntimeWorkspaceActivation['activateManagedWorktree']> {
    return this.workspaceActivation.activateManagedWorktree(...args)
  }

  protected pasteStartupDraftWhenReady(handle: string, draft: WorktreeStartupDraftPaste): void {
    pasteWorktreeStartupDraftWhenReady(this.getWorktreeStartupReadinessHost(), handle, draft)
  }

  /**
   * Only for a newly launched agent, before its first input. Settles when the agent's composer
   * signal fires on a screen with no startup dialog and no Codex provisional header; with
   * `stopOnDialog`, a dialog ends the wait so the caller's idle wait can report it.
   */
  async waitForFreshWorkerComposer(
    handle: string,
    agent: TuiAgent,
    timeoutMs: number,
    {
      requireComposerMarker = true,
      stopOnDialog = false,
      signal
    }: { requireComposerMarker?: boolean; stopOnDialog?: boolean; signal?: AbortSignal } = {}
  ): Promise<RuntimeTerminalWait> {
    const initialPtyId =
      this.getLivePtyForHandle(handle)?.pty.ptyId ?? this.getLiveLeafForHandle(handle).leaf.ptyId
    const stop = new AbortController()
    const onAbort = (): void => stop.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const ptyId = await waitForWorktreeStartupDraft(
      { ...this.getWorktreeStartupReadinessHost(), getPtyId: () => initialPtyId },
      handle,
      agent,
      {
        timeoutMs,
        requireComposerMarker,
        // Every caller pastes and then presses Enter: a worker brief or a launch prompt.
        submit: true,
        signal: stop.signal,
        isShellInFront: async (ownerPtyId) =>
          (await this.readLaunchedAgentForeground(ownerPtyId, agent)) === 'shell',
        accept: (readyPtyId) => {
          const pty = this.ptysById.get(readyPtyId)
          const hold = pty
            ? readFreshComposerHold(
                buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview),
                this.readLiveTerminalScreenLines(readyPtyId)
              )
            : null
          if (hold === 'dialog' && stopOnDialog) {
            stop.abort()
          }
          return hold === null
        }
      }
    )
    signal?.removeEventListener('abort', onAbort)
    if (!ptyId) {
      throw new Error(
        signal?.aborted
          ? 'request_aborted'
          : stop.signal.aborted
            ? 'agent_startup_dialog'
            : 'timeout'
      )
    }
    this.assertLiveTerminalHandleTargetsPty(handle, ptyId)
    if (!this.ptysById.get(ptyId)?.connected) {
      throw new Error('terminal_handle_stale')
    }
    return this.buildTuiIdleProbeResult(handle, null)
  }

  /** What holds the terminal a launch started its agent in, read fresh from the execution host. */
  readLaunchedAgentForeground(ptyId: string, agent: TuiAgent): Promise<LaunchedAgentForeground> {
    return readLaunchedAgentForeground(
      this.ptyController,
      this.launchedAgentHost(ptyId),
      ptyId,
      agent
    )
  }

  /** Whether the pane's execution host can find a launched agent in front: a Windows one cannot. */
  launchedAgentHostProvesAgent(ptyId: string): boolean {
    return !this.launchedAgentHost(ptyId).windows
  }

  private launchedAgentHost(ptyId: string): { remote: boolean; windows: boolean } {
    const pty = this.ptysById.get(ptyId)
    const remote = !!pty?.connectionId
    // A local WSL pane still runs on a Windows host, whose process reads cannot see into it.
    return {
      remote,
      windows: remote ? this.pathFlavorForPty(pty) === 'win32' : process.platform === 'win32'
    }
  }

  protected sendStartupFollowupWhenReady(handle: string, followup: WorktreeStartupFollowup): void {
    sendWorktreeStartupFollowupWhenReady(this.getWorktreeStartupReadinessHost(), handle, followup)
  }

  /** The same follow-up write, awaited: true once the prompt was typed into the agent. */
  deliverStartupFollowup(handle: string, followup: WorktreeStartupFollowup): Promise<boolean> {
    return deliverWorktreeStartupFollowup(this.getWorktreeStartupReadinessHost(), handle, followup)
  }

  protected async provisionManagedWorktreeTerminals(
    args: {
      worktreeSelector: string
      worktreeId: string
      worktreePath: string
      setup?: CreateWorktreeResult['setup']
      defaultTabs?: CreateWorktreeResult['defaultTabs']
      primaryTerminalHandle?: string | null
      hasStartupTerminal: boolean
      setupCommandPlatform: 'windows' | 'posix'
      observeSetupCompletion?: boolean
      // Why: when the agent startup is sequenced to wait for setup
      // (waitForAgentStartup), the startup PTY runs a wrapper that already embeds
      // the setup command. Pass that wrapped command through so the Setup tab runs
      // the same script the agent is waiting on instead of a bare runner.
      wrappedSetupCommand?: string
      // Why: a workspace provisioned in the background must not pull the sidebar
      // to itself; the user never asked to look at these tabs.
      surfaceOwner?: false
    },
    createdWorktree?: Worktree
  ): Promise<{ setupSpawned: boolean; setupTerminalHandle: string | null }> {
    return provisionWorktreeTerminals(
      this.getWorktreeTerminalProvisioningHost(createdWorktree),
      args
    )
  }
}
