// Who may resume a recorded agent conversation: a pane opening over its own record, or a targeted
// resume into a fresh pane. Both pass the same ownership checks and share one in-flight claim.

import { OrcaRuntimeWithApplyMobileSessionTabNavigation } from './apply-mobile-session-tab-navigation'
import type { RuntimeMobileSessionTerminalTab } from '../../../../shared/runtime-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  agentProviderSessionsEqual,
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  getConnectionExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type {
  MobileTerminalResumeCommand,
  OrcaRuntimeWithResolveMobileSessionTerminalCommand as MobileTerminalStartup
} from '../../terminal/launch/mobile-terminal-startup'
import type { OrcaRuntimeWithCreateMobileSessionTerminal as MobileTerminalCreate } from '../../terminal/launch/mobile-terminal-create'
import type { OrcaRuntimeWithStopTerminalsForWorktree as SessionEditHost } from '../../terminal/stop/worktree-terminal-stop'
import { claimWindowWakeRecordForPane, isWindowWakeSleepRecord } from './window-wake-sleep-record'
import {
  AgentSessionResumeClaims,
  type AgentSessionResumeClaim,
  type AgentSessionResumeHold,
  type ResumedAgentSession
} from './agent-session-resume-claims'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'

/** A pane's resume launch, holding the conversation until the pane's spawn binds or releases it. */
export type PaneResumeStartup = MobileTerminalResumeCommand & {
  resumeClaim: AgentSessionResumeClaim
}

export type AgentSessionResumeRefusal =
  | 'window_owns_wake'
  | 'held_elsewhere'
  | 'no_resume_command'
  | 'aborted'
  | 'create_failed'

export type AgentSessionResumeResult =
  | { ok: true; handle: string; paneKey: string; ptyId: string }
  | { ok: false; reason: AgentSessionResumeRefusal }

export abstract class OrcaRuntimeWithResumeAgentSessionInWorkspace extends OrcaRuntimeWithApplyMobileSessionTabNavigation {
  protected abstract resolveMobileSessionResumeCommand(
    ...args: Parameters<MobileTerminalStartup['resolveMobileSessionResumeCommand']>
  ): ReturnType<MobileTerminalStartup['resolveMobileSessionResumeCommand']>
  protected abstract commitWorkspaceSessionEdit(
    ...args: Parameters<SessionEditHost['commitWorkspaceSessionEdit']>
  ): ReturnType<SessionEditHost['commitWorkspaceSessionEdit']>
  abstract createMobileSessionTerminal(
    ...args: Parameters<MobileTerminalCreate['createMobileSessionTerminal']>
  ): ReturnType<MobileTerminalCreate['createMobileSessionTerminal']>

  private readonly agentSessionResumeClaims = new AgentSessionResumeClaims((hold) =>
    this.isAgentSessionResumeHoldSettled(hold)
  )

  /**
   * Resumes one recorded conversation in a fresh pane of its workspace: the exact new binding, or
   * a refusal. Never a plain shell or a fresh agent.
   */
  async resumeAgentSessionInWorkspace(
    worktreeId: string,
    request: {
      agent: TuiAgent
      providerSession: AgentProviderSessionMetadata
      /** The execution host whose hook row reported the session. */
      captureHostId: ExecutionHostId
      mutationId: string
      signal?: AbortSignal
    }
  ): Promise<AgentSessionResumeResult> {
    const refuse = (reason: AgentSessionResumeRefusal): AgentSessionResumeResult => ({
      ok: false,
      reason
    })
    const providerSession = normalizeAgentProviderSession(request.providerSession)
    if (!providerSession) {
      return refuse('no_resume_command')
    }
    const session: ResumedAgentSession = { agent: request.agent, providerSession }
    if (request.signal?.aborted) {
      return refuse('aborted')
    }
    let workspace
    try {
      workspace = await this.resolveTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
    } catch {
      return refuse('no_resume_command')
    }
    // Why: a session id names a transcript on the host that reported it; elsewhere it cannot resume.
    if (getConnectionExecutionHostId(workspace.connectionId) !== request.captureHostId) {
      return refuse('no_resume_command')
    }
    if (await this.isProviderSessionLiveInAnotherPane(session, null)) {
      return refuse('held_elsewhere')
    }
    const records = Object.values(
      this.getWorkspaceSessionForWorktree(worktreeId)?.sleepingAgentSessionsByPaneKey ?? {}
    ).filter(
      (record) =>
        worktreeIdsEqual(record.worktreeId, worktreeId) &&
        record.agent === session.agent &&
        agentProviderSessionsEqual(record.agent, record.providerSession, providerSession)
    )
    if (records.some((record) => !this.isPaneOwnedResumeRecord(record))) {
      return refuse('window_owns_wake')
    }
    // Why: a session two panes record is never resumed automatically (resolvePaneOwnedResumeStartup).
    if (records.length > 1) {
      return refuse('held_elsewhere')
    }
    const record = records[0]
    const resume = this.resolveMobileSessionResumeCommand(workspace, {
      ...session,
      launchConfig: record?.launchConfig
    })
    if (!resume) {
      return refuse('no_resume_command')
    }
    const claim = this.agentSessionResumeClaims.claim(session, null)
    if (!claim) {
      return refuse('held_elsewhere')
    }
    if (record && isWindowWakeSleepRecord(record)) {
      // Why: pane-owned before the spawn, so a window attaching mid-spawn cannot relaunch it.
      const claimed = await this.claimWindowWakeRecord(worktreeId, record)
      if (!claimed) {
        claim.release()
        return refuse(
          this.getAvailableAuthoritativeWindow() ? 'window_owns_wake' : 'held_elsewhere'
        )
      }
    }
    // Why: the last point where nothing has spawned; the create is not aborted mid-spawn, since a
    // renderer tab outlives its awaiter and the resume would then run unclaimed.
    if (request.signal?.aborted) {
      claim.release()
      return refuse('aborted')
    }
    let created
    try {
      created = await this.createMobileSessionTerminal(`id:${worktreeId}`, {
        command: resume.command,
        env: resume.env,
        startupCommandDelivery: resume.startupCommandDelivery,
        launchConfig: resume.launchConfig,
        launchAgent: resume.launchAgent,
        launchRuntime: resume.launchRuntime,
        resumeProviderSession: resume.resumeProviderSession,
        navigation: 'caller',
        select: false,
        // Why: namespaced so another local create reusing the caller's id cannot share its result.
        clientMutationId: `agent-session-resume:${request.mutationId}`
      })
    } catch {
      claim.release()
      return refuse('create_failed')
    }
    const { tab } = created
    const paneKey = makePaneKey(tab.parentTabId, tab.leafId)
    claim.bind({ paneKey, ptyId: tab.ptyId ?? null })
    if (tab.status !== 'ready' || !tab.ptyId) {
      return refuse('create_failed')
    }
    return { ok: true, handle: tab.terminal, paneKey, ptyId: tab.ptyId }
  }

  /**
   * Whether persistence proves this pane's PTY was deliberately taken down and parked
   * (workspace sleep or completed-agent hibernation) rather than lost and awaiting reconnect.
   * Why: `pending-handle` alone cannot tell those apart — a parked pane publishes it
   * indefinitely — and respawning a parked pane re-launches its agent behind the user.
   * Only an automatic activation consults this; a user opening the tab is the wake gesture.
   */
  protected isDeliberatelyParkedPane(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    // Why: 'live'/'quit' captures describe a pane that was still running, so a reconnect
    // must still mint its replacement PTY (#11542). Only a worktree-owned capture records
    // a deliberate takedown the user did not ask to undo.
    return this.getPaneSleepingAgentRecord(worktreeId, tab)?.origin === 'worktree-sleep'
  }

  /**
   * Whether a pane, rather than the host window's cold restore, owns resuming this record.
   * Why: a running agent's worktree-sleep record is relaunched in a fresh tab by the window's
   * worktree activation, so resuming it in a pane as well would run one transcript twice.
   */
  private isPaneOwnedResumeRecord(record: SleepingAgentSessionRecord): boolean {
    // Why: an originless record predates capture origins and carries no proof of which pane or
    // host wrote it, so it is left (record kept) for the window's legacy cleanup (#29303).
    // A host with no window right now has no window wake, so the pane owns the record and claims it.
    return (
      record.origin === 'live' ||
      record.origin === 'quit' ||
      (record.origin === 'worktree-sleep' &&
        (record.state === 'done' || !this.getAvailableAuthoritativeWindow()))
    )
  }

  /**
   * The pane's resume launch: undefined when it owns no record, `{}` (plain shell, record kept,
   * as the window does) when the record cannot be resumed here or the window will wake it.
   */
  protected async resolvePaneOwnedResumeStartup(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): Promise<PaneResumeStartup | Record<string, never> | undefined> {
    const stored = this.getPaneSleepingAgentRecord(worktreeId, tab)
    const record = stored && this.isPaneOwnedResumeRecord(stored) ? stored : null
    if (!record) {
      // Why: a fresh launch would drop the conversation and its recorded flags (#29672).
      return stored && isWindowWakeSleepRecord(stored) ? {} : undefined
    }
    // Why: nothing here spends the record, so a session another pane also records could be
    // resumed twice (two writers on one transcript), as could one already live in another pane.
    const records = this.getWorkspaceSessionForWorktree(worktreeId)?.sleepingAgentSessionsByPaneKey
    const sharedWithAnotherPane = Object.values(records ?? {}).some(
      (other) =>
        other !== record &&
        other.agent === record.agent &&
        agentProviderSessionsEqual(record.agent, other.providerSession, record.providerSession)
    )
    if (
      sharedWithAnotherPane ||
      this.agentSessionResumeClaims.isHeldElsewhere(record, record.paneKey) ||
      (await this.isProviderSessionLiveInAnotherPane(record, record.paneKey)) ||
      this.hookStoreNamesAnotherSessionForPane(record)
    ) {
      return {}
    }
    let resume: MobileTerminalResumeCommand | null
    try {
      const workspace = await this.resolveTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
      resume = this.resolveMobileSessionResumeCommand(workspace, record)
    } catch {
      return {}
    }
    if (!resume) {
      return {}
    }
    if (
      isWindowWakeSleepRecord(record) &&
      !(await this.claimWindowWakeRecord(worktreeId, record))
    ) {
      return {}
    }
    // Why: a targeted resume may have claimed the conversation during the awaits above.
    const resumeClaim = this.agentSessionResumeClaims.claim(record, record.paneKey)
    return resumeClaim ? { ...resume, resumeClaim } : {}
  }

  private claimWindowWakeRecord(
    worktreeId: string,
    record: SleepingAgentSessionRecord
  ): Promise<boolean> {
    const hostId = this.getWorkspaceSessionHostIdForWorktree(worktreeId)
    return claimWindowWakeRecordForPane(
      (edit) => this.commitWorkspaceSessionEdit(hostId, edit),
      // Why: a window that attached during the caller's awaits now owns this record's wake.
      () => Boolean(this.getAvailableAuthoritativeWindow()),
      record
    )
  }

  /** A hold ends once the hook store names the session in its pane, or its PTY proves exited. */
  private isAgentSessionResumeHoldSettled(hold: AgentSessionResumeHold): boolean {
    if (hold.ptyId !== null && this.isPtyKnownExited(hold.ptyId)) {
      return true
    }
    const { paneKey } = hold
    // Why: only a row since the claim; the pane's earlier agent may have named the same session.
    return (
      paneKey !== null &&
      (this.getAgentProviderSessionSnapshotFn?.() ?? []).some(
        (row) =>
          row.paneKey === paneKey &&
          agentProviderSessionsEqual(hold.agent, row.providerSession, hold.providerSession) &&
          (row.evidenceObservedAt ?? row.receivedAt) >= hold.claimedAt
      )
    )
  }

  /** The host's hook store places this conversation in a pane other than `ownPaneKey`, not proven exited. */
  private async isProviderSessionLiveInAnotherPane(
    session: ResumedAgentSession,
    ownPaneKey: string | null
  ): Promise<boolean> {
    const otherPaneKeys = new Set(
      (this.getAgentProviderSessionSnapshotFn?.() ?? [])
        .filter(
          (row) =>
            row.paneKey !== ownPaneKey &&
            agentProviderSessionsEqual(session.agent, row.providerSession, session.providerSession)
        )
        .map((row) => row.paneKey)
    )
    // Why: only a proven exit clears a holder; an unverifiable PTY (dropped SSH relay) or one not
    // yet hydrated after a restart may still be writing the transcript.
    const ptys = [...this.ptysById.values()]
    const holderPaneKeys = [...otherPaneKeys].filter((paneKey) => {
      const panePtys = ptys.filter((pty) => pty.paneKey === paneKey)
      return panePtys.length === 0 || panePtys.some((pty) => !this.isPtyKnownExited(pty.ptyId))
    })
    if (holderPaneKeys.length === 0) {
      return false
    }
    // Why: a shell can outlive the agent; the hook store's proven exit releases a pane whose PTY lives.
    const verdicts = await Promise.all(
      holderPaneKeys.map((paneKey) =>
        this.checkHookAgentPresenceFn
          ? this.checkHookAgentPresenceFn(paneKey, 0).catch(() => null)
          : Promise.resolve(null)
      )
    )
    return verdicts.some((verdict) => verdict !== 'exited')
  }

  /** The pane moved on to another conversation after the record was saved; the hook store is authoritative. */
  private hookStoreNamesAnotherSessionForPane(record: SleepingAgentSessionRecord): boolean {
    return (this.getAgentProviderSessionRowsForPaneFn?.(record.paneKey) ?? []).some(
      (row) =>
        row.providerSession !== undefined &&
        !agentProviderSessionsEqual(record.agent, row.providerSession, record.providerSession)
    )
  }

  private getPaneSleepingAgentRecord(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): SleepingAgentSessionRecord | null {
    const record =
      this.getWorkspaceSessionForWorktree(worktreeId)?.sleepingAgentSessionsByPaneKey?.[
        makePaneKey(tab.parentTabId, tab.leafId)
      ]
    return record && worktreeIdsEqual(record.worktreeId, worktreeId) ? record : null
  }
}
