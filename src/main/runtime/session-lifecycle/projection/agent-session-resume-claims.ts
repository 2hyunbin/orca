import {
  agentProviderSessionsEqual,
  type AgentProviderSessionMetadata
} from '../../../../shared/agent-session-resume'
import type { TuiAgent } from '../../../../shared/tui-agent'

export type ResumedAgentSession = {
  agent: TuiAgent
  providerSession: AgentProviderSessionMetadata
}

/** One conversation's in-flight resume; `paneKey` is null until a fresh pane's create names it. */
export type AgentSessionResumeHold = ResumedAgentSession & {
  paneKey: string | null
  ptyId: string | null
  claimedAt: number
  holders: number
}

/** A resumer's share of a hold: bind it to the spawned PTY, or release it when nothing spawned. */
export type AgentSessionResumeClaim = {
  bind: (binding: { paneKey: string; ptyId: string | null }) => void
  release: () => void
}

/**
 * Which pane is resuming a conversation, from the decision until the hook store can see it.
 * Why: the duplicate-holder guard reads hook rows, which an SSH resume (never seeded) or a spawn
 * still in flight has not written yet, so two resumers could both pass it.
 */
export class AgentSessionResumeClaims {
  private readonly holds = new Set<AgentSessionResumeHold>()

  /** `settled`: the hook store now covers the hold, or its PTY is proven exited. */
  constructor(private readonly settled: (hold: AgentSessionResumeHold) => boolean) {}

  /** Null while another pane's resume of this conversation is unsettled. */
  claim(session: ResumedAgentSession, paneKey: string | null): AgentSessionResumeClaim | null {
    const held = this.find(session)
    if (held) {
      // Why: overlapping opens of one pane resume alongside each other (claimWindowWakeRecordForPane).
      if (paneKey === null || held.paneKey !== paneKey) {
        return null
      }
      held.holders += 1
      return this.share(held)
    }
    const hold: AgentSessionResumeHold = {
      ...session,
      paneKey,
      ptyId: null,
      claimedAt: Date.now(),
      holders: 1
    }
    this.holds.add(hold)
    return this.share(hold)
  }

  /** Whether a resumer other than `paneKey` holds this conversation. */
  isHeldElsewhere(session: ResumedAgentSession, paneKey: string | null): boolean {
    const held = this.find(session)
    return held !== undefined && (paneKey === null || held.paneKey !== paneKey)
  }

  private find(session: ResumedAgentSession): AgentSessionResumeHold | undefined {
    for (const hold of this.holds) {
      if (
        hold.agent !== session.agent ||
        !agentProviderSessionsEqual(hold.agent, hold.providerSession, session.providerSession)
      ) {
        continue
      }
      if (this.settled(hold)) {
        this.holds.delete(hold)
        continue
      }
      return hold
    }
    return undefined
  }

  private share(hold: AgentSessionResumeHold): AgentSessionResumeClaim {
    let open = true
    return {
      bind: ({ paneKey, ptyId }) => {
        if (open) {
          open = false
          hold.paneKey = paneKey
          hold.ptyId = ptyId ?? hold.ptyId
        }
      },
      release: () => {
        if (!open) {
          return
        }
        open = false
        hold.holders -= 1
        if (hold.holders === 0) {
          this.holds.delete(hold)
        }
      }
    }
  }
}
