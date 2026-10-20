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
}

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

  /** Synchronous, before the switch spawn's first await, so a chat start censusing after it refuses. */
  acceptSwitchStart(agent: string, id: string): SwitchClaim {
    const claim = this.liveSwitchClaim(agent, id) ?? { agent, id, at: Date.now(), accepted: false }
    claim.accepted = true
    this.switchClaims.add(claim)
    return claim
  }

  /** Ends this attempt's claim: bound to the execution its spawn produced, or gone when none exists. */
  settleSwitchStart(claim: SwitchClaim, ptyId: string | null): void {
    if (!this.switchClaims.delete(claim)) {
      return
    }
    const pty = ptyId ? this.ptysById.get(ptyId) : undefined
    if (!pty?.incarnationId) {
      return
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
