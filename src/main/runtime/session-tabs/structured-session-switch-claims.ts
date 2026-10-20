import type { AgentProcessIdentity } from '../../../shared/agent-process-presence'
import { isSameAgentProcess } from '../../../shared/agent-process-presence'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { PtyIncarnationId } from '../../../shared/pty-incarnation'
import { chatAgentsShareConversations } from '../../../shared/structured-agent-cli-conversation-adoption'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { OrcaRuntimeWithGetWorktreePs } from '../workspaces/workspace-process-listing'
import { readSwitchPaneAgentProcesses } from './structured-session-switch-observation'

/** A recipe no terminal took yet may lapse; expiry only ends a refusal, the spawn re-checks the chat. */
const UNACCEPTED_SWITCH_CLAIM_MS = 60_000
const SWITCH_START_WATCH_POLLS = 120
const SWITCH_START_WATCH_INTERVAL_MS = 1_000

/** A chat → terminal switch from the chat's stop until its terminal execution exists. */
export type SwitchClaim = {
  agent: string
  id: string
  at: number
  /** A spawn took it: it never lapses, and settles only with that spawn. */
  accepted: boolean
  /** The accepting spawn's identity (its host session, else its pane); only it joins or settles. */
  attempt?: string
  /** The host session to reconcile when the spawn ended without a result. */
  sessionId?: string
  unsettled?: true
}

/** A switch spawn's end: its PTY, a proved non-start, or a session the host may still hold. */
export type SwitchSpawnOutcome = { ptyId: string } | 'not-started' | { unknown: string | undefined }

/** The switch's start bound to the execution it spawned. */
export type SwitchStartProof = {
  incarnationId: PtyIncarnationId
  agent: string
  id: string
  /** The agent processes seen in the pane; none seen keeps the proof until the pane goes. */
  processes: AgentProcessIdentity[]
}

const moving = () =>
  agentSessionRefusalError('agent_session_operation_invalid', {
    reason: 'conversationMovingToTerminal'
  })

export abstract class OrcaRuntimeWithStructuredSessionSwitchClaims extends OrcaRuntimeWithGetWorktreePs {
  private readonly switchClaims = new Set<SwitchClaim>()

  private liveSwitchClaim(agent: string, id: string): SwitchClaim | undefined {
    let live: SwitchClaim | undefined
    for (const claim of this.switchClaims) {
      if (!claim.accepted && Date.now() - claim.at >= UNACCEPTED_SWITCH_CLAIM_MS) {
        this.switchClaims.delete(claim)
      } else if (claim.id === id && chatAgentsShareConversations(claim.agent, agent)) {
        live ??= claim
      }
    }
    return live
  }

  /** Throws while a switch of this conversation has not started its terminal yet. */
  protected assertNoPendingSwitch(agent: string, id: string): void {
    if (this.liveSwitchClaim(agent, id)) {
      throw moving()
    }
  }

  protected boundSwitchStarts(agent: string, id: string) {
    return [...this.ptysById.values()].flatMap((pty) => {
      const proof = pty.switchStart
      return proof &&
        proof.incarnationId === pty.incarnationId &&
        proof.id === id &&
        chatAgentsShareConversations(proof.agent, agent) &&
        this.getPtyLivenessVerdict(pty.ptyId)?.status !== 'exited'
        ? [{ ptyId: pty.ptyId, proof }]
        : []
    })
  }

  /** Synchronous, in the chat's ordered step before its stop: a second switch of the same
   *  conversation, from any client, refuses while the first may still hold it. */
  registerSwitchClaim(agent: string, id: string): SwitchClaim {
    if (this.liveSwitchClaim(agent, id) || this.boundSwitchStarts(agent, id).length > 0) {
      throw agentSessionRefusalError('agent_session_conflict', {
        reason: 'conversationHeldElsewhere'
      })
    }
    const claim = { agent, id, at: Date.now(), accepted: false }
    this.switchClaims.add(claim)
    return claim
  }

  dropSwitchClaim(claim: SwitchClaim): void {
    this.switchClaims.delete(claim)
  }

  /** Synchronous, before the switch spawn's first await, so a chat start censusing after it refuses.
   *  Null refuses: another attempt took this conversation, or a switched terminal may hold it. */
  acceptSwitchStart(
    agent: string,
    id: string,
    attempt: string,
    sessionId: string | undefined
  ): SwitchClaim | null {
    const live = this.liveSwitchClaim(agent, id)
    if (live?.accepted ? live.attempt !== attempt : !live && this.boundSwitchStarts(agent, id)[0]) {
      return null
    }
    const claim = live ?? { agent, id, at: Date.now(), accepted: true }
    Object.assign(claim, { accepted: true, attempt, sessionId: sessionId ?? claim.sessionId })
    delete claim.unsettled
    this.switchClaims.add(claim)
    return claim
  }

  /** Only a PTY binds and only a proved non-start drops; an unknown end waits for the host. */
  settleSwitchAttempt(attempt: string, outcome: SwitchSpawnOutcome): void {
    const claim = [...this.switchClaims].find((c) => c.accepted && c.attempt === attempt)
    const sessionId =
      outcome === 'not-started' ? undefined : 'ptyId' in outcome ? outcome.ptyId : outcome.unknown
    if (claim && !sessionId) {
      this.switchClaims.delete(claim)
    } else if (claim) {
      Object.assign(claim, { sessionId, unsettled: true })
      this.bindSwitchStart(claim)
    }
  }

  /** Unsettled attempts against the host's own session list; a failed read keeps them. */
  protected async reconcileSwitchAttempts(): Promise<void> {
    const open = [...this.switchClaims].filter((c) => c.unsettled && !this.bindSwitchStart(c))
    if (open.length === 0) {
      return
    }
    const listed = await this.ptyController
      ?.listProcesses?.(LOCAL_EXECUTION_HOST_ID)
      .catch(() => null)
    for (const claim of open) {
      if (listed && !this.bindSwitchStart(claim) && !listed.some((p) => p.id === claim.sessionId)) {
        this.switchClaims.delete(claim)
      }
    }
  }

  private bindSwitchStart(claim: SwitchClaim): boolean {
    const pty = claim.sessionId ? this.ptysById.get(claim.sessionId) : undefined
    if (!pty?.incarnationId || !this.switchClaims.delete(claim)) {
      return false
    }
    const key = `${claim.agent}\0${claim.id}`
    const reported =
      pty.cliConversations?.incarnationId === pty.incarnationId
        ? pty.cliConversations.byKey.get(key)?.process
        : undefined
    const proof: SwitchStartProof = {
      incarnationId: pty.incarnationId,
      agent: claim.agent,
      id: claim.id,
      processes: reported ? [reported] : []
    }
    pty.switchStart = proof
    void this.watchSwitchStart(pty.ptyId, proof).catch((error: unknown) =>
      console.warn('[agent-session] could not watch a switched terminal start', error)
    )
    return true
  }

  /** An authentic hook's process joins the proof; identity-only rows carry none. */
  protected noteSwitchStartProcess(
    ptyId: string,
    conversation: { agent: string; id: string },
    process: AgentProcessIdentity
  ): void {
    const pty = this.ptysById.get(ptyId)
    const proof = pty?.switchStart
    if (
      proof &&
      proof.incarnationId === pty.incarnationId &&
      proof.id === conversation.id &&
      chatAgentsShareConversations(proof.agent, conversation.agent) &&
      !proof.processes.some((known) => isSameAgentProcess(known, process))
    ) {
      proof.processes.push(process)
    }
  }

  /** Bounded evidence collection only: it records the agent's identity and never admits anything. */
  private async watchSwitchStart(ptyId: string, proof: SwitchStartProof): Promise<void> {
    for (let poll = 0; poll < SWITCH_START_WATCH_POLLS; poll++) {
      await new Promise((resolve) => setTimeout(resolve, SWITCH_START_WATCH_INTERVAL_MS).unref?.())
      if (this.ptysById.get(ptyId)?.switchStart !== proof || proof.processes.length > 0) {
        return
      }
      const entry = (await this.ptyController?.listProcesses?.(LOCAL_EXECUTION_HOST_ID))?.find(
        (candidate) => candidate.id === ptyId
      )
      if (!entry?.rootProcessId || entry.incarnationId !== proof.incarnationId) {
        continue
      }
      const seen = await readSwitchPaneAgentProcesses(entry.rootProcessId, proof.id)
      if (this.ptysById.get(ptyId)?.switchStart === proof && proof.processes.length === 0) {
        proof.processes.push(...seen)
      }
    }
  }
}
