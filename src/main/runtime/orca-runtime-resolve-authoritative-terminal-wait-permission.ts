import type { OrcaRuntimeWithStopExactTerminalsForWorktree } from './orca-runtime-stop-exact-terminals-for-worktree'
import { TerminalWaitPermission } from './terminal/wait/terminal-wait-permission'
import { OrcaRuntimeWithAgentPromptRequestCorrelation } from './orca-runtime-agent-prompt-request-correlation'
import type { AgentStatusEntry } from '../../shared/agent-status-types'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { renewRuntimeMobileAgentStatusFromPtyTitle } from './runtime-mobile-agent-status-projection'
import type { RuntimeTerminalWriteOptions } from './runtime-terminal-writer'
import type { WriteSettlement } from '../../shared/pty-write-settlement'
import { getRegisteredSshState } from '../ssh/ssh-target-registry'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import type { TerminalAgent } from '../../shared/terminal-agent'
import type { AgentPromptActivity } from './agent-prompt-submission-verification'

export abstract class OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission extends OrcaRuntimeWithAgentPromptRequestCorrelation {
  protected abstract getExistingTerminalHandlesForPtyId(
    ...args: Parameters<
      OrcaRuntimeWithStopExactTerminalsForWorktree['getExistingTerminalHandlesForPtyId']
    >
  ): ReturnType<OrcaRuntimeWithStopExactTerminalsForWorktree['getExistingTerminalHandlesForPtyId']>

  private readonly waitPermission = new TerminalWaitPermission(
    {
      getPty: (id) => this.ptysById.get(id),
      getPtyTitleDisplayClear: (id) => this.getPtyTitleDisplayClear(id),
      getPromptLifecycle: (id) => this.agentPromptLifecycleByPtyId.get(id),
      getExistingTerminalHandlesForPtyId: (id) => this.getExistingTerminalHandlesForPtyId(id),
      collectPaneKeysForPty: (id) => this.collectPaneKeysForPty(id),
      getAgentStatusSnapshotForPane: () => this.getAgentStatusSnapshotForPaneFn,
      getAgentStatusSnapshot: () => this.getAgentStatusSnapshotFn?.(),
      getExplicitStatusFloor: (id) => this.agentPromptExplicitStatusFloorByPtyId.get(id),
      readLastInputAt: (id) => this.terminalRunFacts.readLastInputAt(id),
      getPtyHandle: (id) => this.handleByPtyId.get(id),
      getTerminalAgentStatusSnapshot: (handle, id) =>
        this.getTerminalAgentStatusSnapshot(handle, id)
    },
    this.terminalAgentStatus
  )

  protected resolveAuthoritativeTerminalWaitPermission(
    ...args: Parameters<TerminalWaitPermission['resolveAuthoritativeTerminalWaitPermission']>
  ) {
    return this.waitPermission.resolveAuthoritativeTerminalWaitPermission(...args)
  }

  protected getTerminalWaitPermissionInputs(
    ...args: Parameters<TerminalWaitPermission['getTerminalWaitPermissionInputs']>
  ) {
    return this.waitPermission.getTerminalWaitPermissionInputs(...args)
  }

  protected readTuiIdleHookTurnForPty(
    ...args: Parameters<TerminalWaitPermission['readTuiIdleHookTurnForPty']>
  ) {
    return this.waitPermission.readTuiIdleHookTurnForPty(...args)
  }

  readOpenCodeStartupPromptOwner(ptyId: string, incarnationId: string, launchToken: string) {
    const pty = this.ptysById.get(ptyId)
    if (!pty || pty.incarnationId !== incarnationId) {
      return null
    }
    // The runtime launch route admits identity immediately after low-level spawn returns.
    if (pty.launchToken === null && pty.launchAgent === null && pty.launchIncarnationId === null) {
      return 'pending' as const
    }
    if (
      pty.launchIncarnationId !== incarnationId ||
      pty.launchToken !== launchToken ||
      (pty.launchAgent !== 'opencode' && pty.launchAgent !== 'opencode2')
    ) {
      return null
    }
    return this.terminalRunFacts.read(ptyId, incarnationId)
  }

  renewMobileAgentStatusFromPtyTitle(
    status: AgentStatusEntry | null,
    pty: RuntimePtyWorktreeRecord | null,
    options: { preserveQuestionUnderShellTitle?: boolean } = {}
  ): AgentStatusEntry | null {
    return renewRuntimeMobileAgentStatusFromPtyTitle(status, pty, options)
  }

  protected writeTerminalAction(
    ptyId: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    payload: string,
    options: RuntimeTerminalWriteOptions
  ): Promise<WriteSettlement | undefined> {
    return this.terminalWriter.writeAction(ptyId, action, payload, options)
  }

  protected writeTerminalInputChunks(
    ptyId: string,
    text: string,
    options: RuntimeTerminalWriteOptions
  ): Promise<WriteSettlement | undefined> {
    return this.terminalWriter.writeChunks(ptyId, text, options)
  }

  /** Platform of the host whose pty transport ingests our writes -- deliberately NOT the OS
   *  the command runs under. A WSL pane is spawned as `wsl.exe` through the Windows ConPTY
   *  (see local-pty-provider), so it pays the ConPTY ingest cost even though its shell is
   *  Linux; an SSH pane is spawned by node-pty on the remote host, so the client's
   *  process.platform says nothing about it. */
  protected getPtyWriteHostPlatform(ptyId: string): NodeJS.Platform {
    const pty = this.ptysById.get(ptyId)
    const connectionId = pty?.connectionId
    if (!connectionId) {
      return process.platform
    }
    const remotePlatform = getRegisteredSshState(connectionId)?.remotePlatform
    if (remotePlatform) {
      return remotePlatform
    }
    // Why: remotePlatform only arrives with the relay handshake; until then the worktree path
    // flavor is the same signal getAgentLaunchPlatformForRepo already trusts for a remote repo.
    const worktreePath = pty ? splitWorktreeIdForFilesystem(pty.worktreeId)?.worktreePath : null
    return worktreePath && isWindowsAbsolutePathLike(worktreePath) ? 'win32' : 'linux'
  }

  protected getPtyAgent(ptyId: string): TerminalAgent | null {
    const pty = this.ptysById.get(ptyId)
    return pty?.launchAgent ?? pty?.foregroundAgent ?? null
  }

  protected assertAgentPromptPermissionSafe(
    baseline: AgentPromptActivity,
    current: AgentPromptActivity
  ): void {
    if (
      current.status === 'permission' ||
      current.permissionSequence > baseline.permissionSequence
    ) {
      throw new Error('agent_prompt_blocked')
    }
  }

  protected assertAgentPromptGeneration(ptyId: string, expected: number): void {
    if (this.getPtyLifecycleGeneration(ptyId) !== expected) {
      throw new Error('terminal_handle_stale')
    }
  }
}
