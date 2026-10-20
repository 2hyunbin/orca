// Layout-owner build: main's one start of a restored pane that has no live terminal, for every
// trigger that is not a desktop window's own restore (a client's first view, a CLI or
// orchestration send, wait, read or wake). Restores from the pane's stored terminal when this
// workspace owns it, resuming the pane's sleeping agent when it has one.

import {
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import { isPtySessionIdOwnedByWorktree } from '../../../../shared/pty-session-id-format'
import { makePaneKey } from '../../../../shared/stable-pane-id'

export type RestoredPane = { worktreeId: string; tabId: string; leafId: string }

export type RestoredPaneStartPlan = {
  /** The terminal it restores from, kept so the service restores its screen or holds it. */
  sessionId?: string
  resume?: {
    agent: ResumableTuiAgent
    providerSession: AgentProviderSessionMetadata
    launchConfig?: SleepingAgentLaunchConfig
  }
}

export type RestoredPaneStartPorts = {
  /** The pane's stored terminal, or null for a pane main no longer holds. */
  boundPtyId: (pane: RestoredPane) => string | null | undefined
  isLive: (ptyId: string) => boolean
  sleepingRecord: (pane: RestoredPane) => SleepingAgentSessionRecord | null
  /** Starts the pane in place; resolves to the terminal bound to it. */
  start: (pane: RestoredPane, plan: RestoredPaneStartPlan) => Promise<string>
}

/** How a restored pane starts: from its own stored terminal, resuming a local agent record. */
export function restoredPaneStartPlan(
  pane: RestoredPane,
  boundPtyId: string | null | undefined,
  record: SleepingAgentSessionRecord | null
): RestoredPaneStartPlan {
  const providerSession = normalizeAgentProviderSession(record?.providerSession)
  // A record captured over another host's connection names a transcript only that host has.
  const resumable =
    record && !record.connectionId && isResumableTuiAgent(record.agent) && providerSession
  return {
    ...(boundPtyId && isPtySessionIdOwnedByWorktree(boundPtyId, pane.worktreeId)
      ? { sessionId: boundPtyId }
      : {}),
    ...(resumable
      ? {
          resume: {
            agent: record.agent,
            providerSession,
            ...(record.launchConfig ? { launchConfig: record.launchConfig } : {})
          }
        }
      : {})
  }
}

export class RestoredPaneStarter {
  private readonly inFlight = new Map<string, Promise<string | null>>()

  constructor(private readonly ports: RestoredPaneStartPorts) {}

  /**
   * The pane's live terminal, started once if it has none: concurrent triggers share one start.
   * Null for a pane main no longer holds. A start another starter won still resolves to its
   * terminal, so every caller ends bound to the same one.
   */
  ensureStarted(pane: RestoredPane): Promise<string | null> {
    const key = makePaneKey(pane.tabId, pane.leafId)
    const running = this.inFlight.get(key)
    if (running) {
      return running
    }
    const bound = this.ports.boundPtyId(pane)
    if (bound === null) {
      return Promise.resolve(null)
    }
    if (bound && this.ports.isLive(bound)) {
      return Promise.resolve(bound)
    }
    const start = this.ports
      .start(pane, restoredPaneStartPlan(pane, bound, this.ports.sleepingRecord(pane)))
      .catch((error: unknown) => {
        const winner = this.ports.boundPtyId(pane)
        if (winner && this.ports.isLive(winner)) {
          return winner
        }
        throw error
      })
      .finally(() => {
        if (this.inFlight.get(key) === start) {
          this.inFlight.delete(key)
        }
      })
    this.inFlight.set(key, start)
    return start
  }
}
