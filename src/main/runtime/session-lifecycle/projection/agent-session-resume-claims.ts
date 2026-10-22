import {
  agentProviderSessionsEqual,
  type AgentProviderSessionMetadata
} from '../../../../shared/agent-session-resume'
import type { TuiAgent } from '../../../../shared/tui-agent'

export type ResumedAgentSession = {
  agent: TuiAgent
  providerSession: AgentProviderSessionMetadata
}

/** One conversation's resume into one pane, from the decision until the hook store covers it. */
export type AgentSessionResumeHold = ResumedAgentSession & {
  paneKey: string
  claimedAt: number
}

type Hold = AgentSessionResumeHold & { holders: number; stopWatchingExit: () => void }

/** A resumer's share of a hold: bind it to the spawned PTY, or release it when nothing spawned. */
export type AgentSessionResumeClaim = {
  /** Without an id, binds the PTY the pane gained since the claim, if the runtime holds one. */
  bind: (ptyId?: string | null) => void
  release: () => void
}

/**
 * Which pane is resuming a conversation, taken before any awaited decision and held through the
 * spawn. Why: the duplicate-holder guard reads hook rows, which an SSH resume (never seeded) or a
 * spawn still in flight has not written yet, so two resumers could both pass it.
 */
export class AgentSessionResumeClaims {
  private readonly holds = new Set<Hold>()

  constructor(
    private readonly lifecycle: {
      /** The hook store now names the session in the hold's pane. */
      reported: (hold: AgentSessionResumeHold) => boolean
      /** Calls `onExit` once the PTY proves exited; returns the unsubscribe. */
      watchExit: (ptyId: string, onExit: () => void) => () => void
      /** The PTYs the runtime has bound to this pane. */
      panePtyIds: (paneKey: string) => string[]
    }
  ) {}

  /** Null while another pane's resume of this conversation is unsettled. */
  claim(session: ResumedAgentSession, paneKey: string): AgentSessionResumeClaim | null {
    const held = this.find(session)
    if (held) {
      // Why: overlapping opens of one pane resume alongside each other (claimWindowWakeRecordForPane).
      if (held.paneKey !== paneKey) {
        return null
      }
      held.holders += 1
      return this.share(held)
    }
    const hold: Hold = {
      ...session,
      paneKey,
      claimedAt: Date.now(),
      holders: 1,
      stopWatchingExit: () => {}
    }
    this.holds.add(hold)
    return this.share(hold)
  }

  private find(session: ResumedAgentSession): Hold | undefined {
    for (const hold of this.holds) {
      if (
        hold.agent !== session.agent ||
        !agentProviderSessionsEqual(hold.agent, hold.providerSession, session.providerSession)
      ) {
        continue
      }
      // Why: hook rows outlive the agent's exit, so reading them at the next claim is enough.
      if (this.lifecycle.reported(hold)) {
        this.end(hold)
        continue
      }
      return hold
    }
    return undefined
  }

  private end(hold: Hold): void {
    hold.stopWatchingExit()
    this.holds.delete(hold)
  }

  private share(hold: Hold): AgentSessionResumeClaim {
    let open = true
    const priorPtyIds = new Set(this.lifecycle.panePtyIds(hold.paneKey))
    return {
      bind: (exact) => {
        if (!open) {
          return
        }
        open = false
        // Why: a create can spawn and then fail; its PTY's exit must still end the hold.
        const ptyId =
          exact ?? this.lifecycle.panePtyIds(hold.paneKey).findLast((id) => !priorPtyIds.has(id))
        if (ptyId && this.holds.has(hold)) {
          hold.stopWatchingExit()
          hold.stopWatchingExit = this.lifecycle.watchExit(ptyId, () => this.end(hold))
        }
      },
      release: () => {
        if (!open) {
          return
        }
        open = false
        hold.holders -= 1
        if (hold.holders === 0) {
          this.end(hold)
        }
      }
    }
  }
}
