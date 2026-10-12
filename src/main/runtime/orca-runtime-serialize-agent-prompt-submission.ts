import type { OrcaRuntimeWithGetPtyRecordForPaneKey } from './orca-runtime-get-pty-record-for-pane-key'
import type { OrcaRuntimeWithBuildPtyTerminalSummary } from './orca-runtime-build-pty-terminal-summary'
import type { OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission } from './orca-runtime-resolve-authoritative-terminal-wait-permission'
import { selectFreshExplicitAgentStatus } from './runtime-hook-agent-row-selection'
import { RuntimeTerminalAgentExitConfirmation } from './terminal/status/terminal-agent-exit-confirmation'
import type { RuntimeTerminalAgentStatus } from '../../shared/runtime-types'
import type { RuntimeTerminalAgentStatusSnapshot } from './runtime-terminal-agent-status-query'
import { getDisplayPromptLifecycle } from './runtime-worktree-status-projection'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { hasCompatibleAgentTitleIdentity } from '../../shared/agent-title-owner'
import type { PtyForegroundProcessRead } from './runtime-terminal-contracts'
import type {
  AgentPromptActivity,
  AgentPromptWaitTextCache
} from './agent-prompt-submission-verification'
import { readAgentPromptWaitText } from './agent-prompt-submission-verification'
import type { AgentStatus } from '../../shared/agent-detection'

export abstract class OrcaRuntimeWithSerializeAgentPromptSubmission extends RuntimeTerminalAgentExitConfirmation {
  protected abstract getPaneKeyForTerminalHandle(
    ...args: Parameters<OrcaRuntimeWithGetPtyRecordForPaneKey['getPaneKeyForTerminalHandle']>
  ): ReturnType<OrcaRuntimeWithGetPtyRecordForPaneKey['getPaneKeyForTerminalHandle']>

  protected abstract assertLiveTerminalHandleTargetsPty(
    ...args: Parameters<
      OrcaRuntimeWithBuildPtyTerminalSummary['assertLiveTerminalHandleTargetsPty']
    >
  ): ReturnType<OrcaRuntimeWithBuildPtyTerminalSummary['assertLiveTerminalHandleTargetsPty']>

  protected abstract getTerminalWaitPermissionInputs(
    ...args: Parameters<
      OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission['getTerminalWaitPermissionInputs']
    >
  ): ReturnType<
    OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission['getTerminalWaitPermissionInputs']
  >

  protected abstract resolveAuthoritativeTerminalWaitPermission(
    ...args: Parameters<
      OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission['resolveAuthoritativeTerminalWaitPermission']
    >
  ): ReturnType<
    OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission['resolveAuthoritativeTerminalWaitPermission']
  >
  protected serializeAgentPromptSubmission<T>(
    ptyId: string,
    generation: number,
    submit: () => Promise<T>
  ): Promise<T> {
    return this.promptSubmissions.serializeAgentPromptSubmission(ptyId, generation, submit)
  }

  getTerminalAgentStatus(handle: string): Promise<RuntimeTerminalAgentStatus> {
    return this.terminalAgentStatus.getStatus(handle)
  }

  protected getTerminalAgentStatusPtyId(handle: string): string {
    return this.terminalAgentStatus.getPtyId(handle)
  }

  protected getTerminalAgentStatusSnapshot(
    handle: string,
    expectedPtyId: string,
    waitTextOverride?: string
  ): RuntimeTerminalAgentStatusSnapshot {
    const snapshot = this.terminalAgentStatus.getSnapshot(handle, expectedPtyId)
    return waitTextOverride === undefined ? snapshot : { ...snapshot, waitText: waitTextOverride }
  }

  protected shouldDelayPtyBackedMobileSnapshotForForegroundAgent(
    pty: RuntimePtyWorktreeRecord,
    title: string
  ): boolean {
    return (
      !pty.launchAgent && pty.foregroundAgent === null && hasCompatibleAgentTitleIdentity(title)
    )
  }

  protected readPtyForegroundProcessFromController(
    ptyId: string,
    afterTitleObservation = 0
  ): Promise<PtyForegroundProcessRead> | null {
    return this.ptyForegroundAgent.read(ptyId, afterTitleObservation)
  }

  /**
   * Schedules an asynchronous query to check which agent process is currently
   * running in the foreground of a PTY.
   */
  protected refreshPtyForegroundAgent(ptyId: string): void {
    void this.ptyForegroundAgent.refresh(ptyId)
  }

  protected getPendingForegroundAgentRefreshForTitle(
    ptyId: string,
    titleObservedAt: number
  ): Promise<boolean> | undefined {
    return this.ptyForegroundAgent.getPending(ptyId, titleObservedAt)
  }

  protected delayPtyBackedMobileSnapshotForForegroundAgent(
    ptyId: string,
    titleObservedAt: number,
    foregroundRefresh: Promise<boolean>
  ): void {
    this.ptyForegroundAgent.delaySnapshot(ptyId, titleObservedAt, foregroundRefresh)
  }

  protected getFreshExplicitAgentStatusForHandle(
    handle: string,
    paneKeyOverride?: string | null
  ): {
    status: NonNullable<RuntimeTerminalAgentStatus['status']>
    updatedAt: number
    stateStartedAt: number
  } | null {
    return selectFreshExplicitAgentStatus({
      handle,
      paneKey: paneKeyOverride ?? this.getPaneKeyForTerminalHandle(handle),
      hookRows: this.getAgentStatusSnapshotFn?.() ?? []
    })
  }

  protected getAgentPromptActivity(
    handle: string,
    ptyId: string,
    waitTextCache?: AgentPromptWaitTextCache
  ): AgentPromptActivity {
    this.assertLiveTerminalHandleTargetsPty(handle, ptyId)
    const outputSequence = this.getPtyOutputSequence(ptyId)
    const explicit = this.getFreshExplicitAgentStatusForPty(handle, ptyId)
    const explicitFloor = this.agentPromptExplicitStatusFloorByPtyId.get(ptyId)
    const nativeLifecycle = this.agentPromptLifecycleByPtyId.get(ptyId)
    // Why projected: verification compares against main's baseline, which held a stale-working clear.
    const lifecycle = getDisplayPromptLifecycle(
      nativeLifecycle,
      this.getPtyTitleDisplayClear(ptyId)
    )
    const ptyStatus =
      lifecycle || explicitFloor === undefined
        ? (this.ptysById.get(ptyId)?.lastAgentStatus ?? null)
        : null
    const lifecycleIsNewer =
      lifecycle &&
      (!explicit ||
        lifecycle.updatedAt > explicit.updatedAt ||
        (lifecycle.updatedAt === explicit.updatedAt && lifecycle.status === 'permission'))
    const waitText = waitTextCache
      ? readAgentPromptWaitText(
          waitTextCache,
          outputSequence,
          () => this.getTerminalAgentStatusSnapshot(handle, ptyId).waitText
        )
      : undefined
    const waitInputs = this.getTerminalWaitPermissionInputs(handle, ptyId, waitText)
    const status = this.hasAuthoritativeTerminalWaitPermission(
      waitInputs.terminal,
      explicit,
      waitInputs.lifecycle
    )
      ? 'permission'
      : lifecycleIsNewer
        ? lifecycle.status
        : (explicit?.status ?? ptyStatus ?? null)
    return {
      generation: this.getPtyLifecycleGeneration(ptyId),
      permissionSequence: this.agentPromptPermissionSequenceByPtyId.get(ptyId) ?? 0,
      workingSequence: nativeLifecycle?.workingSequence ?? 0,
      explicitWorkingStartedAt: explicit?.status === 'working' ? explicit.stateStartedAt : null,
      outputSequence,
      status
    }
  }

  protected hasAuthoritativeTerminalWaitPermission(
    terminal: RuntimeTerminalAgentStatusSnapshot,
    explicitStatus: { status: AgentStatus; updatedAt: number } | null,
    lifecycle: { status: AgentStatus | null; updatedAt: number } | null | undefined
  ): boolean {
    return (
      this.resolveAuthoritativeTerminalWaitPermission(terminal, explicitStatus, lifecycle) !== null
    )
  }

  protected getFreshExplicitAgentStatusForPty(handle: string, ptyId: string) {
    const explicit = this.getFreshExplicitAgentStatusForHandle(handle)
    const floor = this.agentPromptExplicitStatusFloorByPtyId.get(ptyId)
    return explicit && (floor === undefined || explicit.updatedAt > floor) ? explicit : null
  }
}
