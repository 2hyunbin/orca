// The conversation index of chat → terminal switch starts. It projects the owner's own answer and
// never settles a start from a caller's success, exception or a session list's absence.
import { randomUUID } from 'node:crypto'
import type { AgentProcessIdentity } from '../../../shared/agent-process-presence'
import { isSameAgentProcess } from '../../../shared/agent-process-presence'
import { chatAgentsShareConversations } from '../../../shared/structured-agent-cli-conversation-adoption'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import {
  isTerminalSwitchDescriptor,
  type TerminalSwitchDescriptor,
  type TerminalSwitchObservation,
  type TerminalSwitchWrite
} from '../../../shared/terminal-switch'
import type { AgentSessionRecordStore } from '../agent-session-record-store'
import { setAgentSessionRecordTerminalSwitch } from '../agent-session-record-terminal-switch'
import { OrcaRuntimeWithGetWorktreePs } from '../workspaces/workspace-process-listing'
import { isLaterSwitchHostBoot, readSwitchHostBoot } from './structured-session-switch-boot'
import { seedResumeLaunchIdentity } from '../../ipc/pty/pane/resume-launch-identity'
import { adoptsCliConversations } from '../../../shared/structured-agent-cli-conversation-adoption'
import {
  readSwitchPaneAgentProcesses,
  readSwitchShellProcess,
  switchStartProcessVerdict
} from './structured-session-switch-observation'

/** Unfenced: the descriptor is the switch owner's obligation, not the writer lease. */
const writeTerminalSwitch = (
  store: Pick<AgentSessionRecordStore, 'transitionHandoff'>,
  sessionId: string,
  write: TerminalSwitchWrite
) =>
  store.transitionHandoff(sessionId, (record) =>
    setAgentSessionRecordTerminalSwitch(record, write, Date.now())
  )

/** A recipe no terminal took may lapse; once taken, only its owner ends it. */
const UNACCEPTED_SWITCH_CLAIM_MS = 60_000
const SWITCH_START_WATCH_POLLS = 120
const SWITCH_START_WATCH_INTERVAL_MS = 1_000

/** One switch, from the chat's stop. Accepted, it is saved on the chat it left. */
export type SwitchClaim = TerminalSwitchDescriptor & {
  chatSessionId: string
  at: number
  accepted: boolean
  /** The descriptor holds this generation; later evidence only updates it. */
  saved: boolean
  /** Evidence learned but not yet saved; the next observation retries it. */
  unsaved?: boolean
}

export const switchMovingRefusal = () =>
  agentSessionRefusalError('agent_session_operation_invalid', {
    reason: 'conversationMovingToTerminal'
  })
export const switchHeldRefusal = () =>
  agentSessionRefusalError('agent_session_conflict', { reason: 'conversationHeldElsewhere' })

export abstract class OrcaRuntimeWithStructuredSessionSwitchClaims extends OrcaRuntimeWithGetWorktreePs {
  private readonly switchClaims = new Map<string, SwitchClaim>()
  private switchClaimsLoaded: Promise<void> | null = null

  protected switchClaimsFor(agent: string, id: string): SwitchClaim[] {
    return [...this.switchClaims.values()].filter((claim) => {
      if (!claim.accepted && Date.now() - claim.at >= UNACCEPTED_SWITCH_CLAIM_MS) {
        this.switchClaims.delete(claim.generation)
        return false
      }
      return claim.providerSessionId === id && chatAgentsShareConversations(claim.agent, agent)
    })
  }

  /** Accepted switches saved before a restart stay owed until their owner proves them over. */
  protected loadSwitchClaims(): Promise<void> {
    this.switchClaimsLoaded ??= this.openAgentSessionRecordStore().then(
      (store) => {
        for (const { sessionId, terminalSwitch } of store.listRecords()) {
          if (isTerminalSwitchDescriptor(terminalSwitch)) {
            const claim = {
              ...terminalSwitch,
              processes: [...terminalSwitch.processes],
              chatSessionId: sessionId,
              at: 0,
              accepted: true,
              saved: true
            }
            this.switchClaims.set(
              terminalSwitch.generation,
              this.switchClaims.get(claim.generation) ?? claim
            )
          }
        }
      },
      (error: unknown) => {
        this.switchClaimsLoaded = null
        throw error
      }
    )
    return this.switchClaimsLoaded
  }

  /** After a restart, a reattached switch terminal asks the original owner for its binding;
   *  the stamp is rebuilt from the saved switch and that answer, never persisted itself. */
  override registerPty(...args: Parameters<OrcaRuntimeWithGetWorktreePs['registerPty']>): void {
    super.registerPty(...args)
    const reattached = args[3]?.providerReattachLaunchIdentity
    if (!reattached || !adoptsCliConversations(reattached.launchAgent)) {
      return
    }
    void this.loadSwitchClaims()
      .then(async () => {
        for (const claim of this.switchClaims.values()) {
          const seen = claim.accepted ? await this.observeSwitch(claim, false) : null
          if (seen?.state === 'bound' && seen.ptyId === args[0]) {
            await this.noteSwitchBound(claim, seen)
          }
        }
      })
      .catch(() => undefined)
  }

  /** Presents a switch's conversation on its pane, only while that pane runs its exact execution. */
  private presentSwitchBinding(claim: SwitchClaim): void {
    const pty = claim.ptyId ? this.ptysById.get(claim.ptyId) : undefined
    if (
      !pty?.incarnationId ||
      pty.incarnationId !== claim.incarnationId ||
      pty.paneKey !== claim.paneKey ||
      this.switchClaims.get(claim.generation) !== claim
    ) {
      return
    }
    const row = this.getAgentProviderSessionRows().find(
      (candidate) =>
        candidate.paneKey === claim.paneKey &&
        candidate.providerSession?.id === claim.providerSessionId
    )
    seedResumeLaunchIdentity({
      paneKey: claim.paneKey,
      launchAgent: claim.agent,
      resumeProviderSession: row?.providerSession ?? {
        key: 'session_id',
        id: claim.providerSessionId
      },
      worktreeId: pty.worktreeId,
      launchedAt: 0,
      execution: { ptyId: pty.ptyId, incarnationId: pty.incarnationId }
    })
  }

  /** Throws while a switch of this conversation exists: one no terminal took yet, or with `all`, any. */
  protected assertNoPendingSwitch(agent: string, id: string, all = false): void {
    if (this.switchClaimsFor(agent, id).some((claim) => all || !claim.accepted)) {
      throw switchMovingRefusal()
    }
  }

  /** The owner a fresh switch start here would go to; null when this route cannot hold one. */
  async terminalSwitchOwner(): Promise<string | null> {
    return (await this.ptyController?.terminalSwitches?.owner().catch(() => null)) ?? null
  }

  /** In the chat's ordered step before its stop: one switch of a conversation at a time. */
  registerSwitchClaim(
    agent: string,
    id: string,
    chatSessionId: string,
    owner: string
  ): SwitchClaim {
    if (this.switchClaimsFor(agent, id).length > 0) {
      throw switchHeldRefusal()
    }
    const claim: SwitchClaim = {
      generation: randomUUID(),
      agent,
      providerSessionId: id,
      owner,
      paneKey: '',
      processes: [],
      chatSessionId,
      at: Date.now(),
      accepted: false,
      saved: false
    }
    this.switchClaims.set(claim.generation, claim)
    return claim
  }

  /** Only a recipe no terminal took can be withdrawn. */
  dropSwitchClaim(claim: SwitchClaim): void {
    if (!claim.accepted) {
      this.switchClaims.delete(claim.generation)
    }
  }

  /** Synchronous, before the switch spawn's first await. A generation takes one pane; a retry there
   *  joins it, and an expired or unknown recipe is refused, never reminted. */
  acceptSwitchStart(generation: string, paneKey: string): SwitchClaim | null {
    const claim = this.switchClaims.get(generation)
    if (
      !claim ||
      (claim.accepted
        ? claim.paneKey !== paneKey
        : Date.now() - claim.at >= UNACCEPTED_SWITCH_CLAIM_MS)
    ) {
      return null
    }
    Object.assign(claim, { accepted: true, paneKey })
    return claim
  }

  /** Saved before dispatch, so a restart still knows the start may exist. A retired claim's
   *  late evidence never writes, and the store only updates the generation it holds. */
  async saveSwitchClaim(claim: SwitchClaim): Promise<boolean> {
    claim.boot ??= await readSwitchHostBoot()
    const { chatSessionId, at: _at, accepted: _a, saved, unsaved: _u, ...descriptor } = claim
    if (saved && this.switchClaims.get(claim.generation) !== claim) {
      return false
    }
    const store = await this.openAgentSessionRecordStore()
    // A copy: the store freezes what it commits, and this claim keeps collecting evidence.
    const snapshot = { ...descriptor, processes: [...descriptor.processes] }
    const next = await writeTerminalSwitch(
      store,
      chatSessionId,
      saved ? { update: snapshot } : { accept: snapshot }
    ).catch(() => null)
    const ok = next?.terminalSwitch?.generation === claim.generation
    Object.assign(claim, { saved: saved || ok, unsaved: !ok })
    return ok
  }

  /** The owner's fields for the dispatch; evidence collection starts with it and decides nothing. */
  dispatchSwitchStart(claim: SwitchClaim): { switchGeneration: string; switchOwner: string } {
    void this.watchSwitchStart(claim).catch((error: unknown) =>
      console.warn('[agent-session] could not watch a switched terminal start', error)
    )
    return { switchGeneration: claim.generation, switchOwner: claim.owner }
  }

  /** The owner's word; when it is gone, only the execution it recorded can prove the start over.
   *  `fence` makes an unseen generation unusable, so its absence is a proved non-start. */
  protected async observeSwitch(
    claim: SwitchClaim,
    fence: boolean
  ): Promise<TerminalSwitchObservation> {
    const answers = await this.ptyController?.terminalSwitches
      ?.observe(claim.generation, fence)
      .catch(() => null)
    const own = answers?.find((answer) => answer.owner === claim.owner)
    // An owner that could not answer is not a lost one.
    if (own || !answers) {
      return own?.observation ?? { state: 'unverifiable' }
    }
    // Every reachable owner answered and none is this one: only the execution can end it.
    // Only clock-free facts prove a later boot; a wall clock can step without one.
    if (claim.boot && isLaterSwitchHostBoot(claim.boot, await readSwitchHostBoot())) {
      return { state: 'ended' }
    }
    const recorded = claim.shell ? [claim.shell, ...claim.processes] : []
    const verdicts = await Promise.all(recorded.map(switchStartProcessVerdict))
    return recorded.length > 0 && verdicts.every((verdict) => verdict === 'exited')
      ? { state: 'ended' }
      : { state: 'unverifiable' }
  }

  /** The exact execution the owner bound, saved with its shell's identity. */
  protected async noteSwitchBound(
    claim: SwitchClaim,
    bound: Extract<TerminalSwitchObservation, { state: 'bound' }>
  ): Promise<void> {
    if (
      claim.ptyId === bound.ptyId &&
      claim.incarnationId === bound.incarnationId &&
      (claim.shell || !bound.shellPid) &&
      !claim.unsaved
    ) {
      this.presentSwitchBinding(claim)
      return
    }
    const shell = bound.shellPid ? await readSwitchShellProcess(bound.shellPid) : null
    Object.assign(claim, { ptyId: bound.ptyId, incarnationId: bound.incarnationId })
    if (shell) {
      claim.shell = shell
    }
    await this.saveSwitchClaim(claim)
    this.presentSwitchBinding(claim)
  }

  protected async releaseSwitchClaim(claim: SwitchClaim): Promise<void> {
    if (this.switchClaims.get(claim.generation) !== claim) {
      return
    }
    this.switchClaims.delete(claim.generation)
    const store = await this.openAgentSessionRecordStore()
    await writeTerminalSwitch(store, claim.chatSessionId, { clear: claim.generation }).catch(
      (error: unknown) => console.warn('[agent-session] could not clear a finished switch', error)
    )
  }

  /** An authentic hook's process joins the evidence; identity-only rows carry none. */
  protected noteSwitchStartProcess(
    ptyId: string,
    conversation: { agent: string; id: string },
    process: AgentProcessIdentity
  ): void {
    for (const claim of this.switchClaimsFor(conversation.agent, conversation.id)) {
      if (
        claim.ptyId === ptyId &&
        !claim.processes.some((known) => isSameAgentProcess(known, process))
      ) {
        claim.processes.push(process)
        void this.saveSwitchClaim(claim)
      }
    }
  }

  /** Bounded evidence collection only: it records identities and never fences or releases. */
  private async watchSwitchStart(claim: SwitchClaim): Promise<void> {
    for (let poll = 0; poll < SWITCH_START_WATCH_POLLS && claim.processes.length === 0; poll++) {
      await new Promise((resolve) => setTimeout(resolve, SWITCH_START_WATCH_INTERVAL_MS).unref?.())
      if (this.switchClaims.get(claim.generation) !== claim) {
        return
      }
      const seen = await this.observeSwitch(claim, false)
      if (seen.state === 'ended') {
        return
      }
      if (seen.state === 'bound' && seen.shellPid) {
        await this.noteSwitchBound(claim, seen)
        const found = await readSwitchPaneAgentProcesses(seen.shellPid, claim.providerSessionId)
        if (found.length > 0 && claim.processes.length === 0) {
          claim.processes.push(...found)
          await this.saveSwitchClaim(claim)
        }
      }
    }
  }
}
