import type { EnrichedAgentHookEventPayload } from './server-types'

/** A main-agent turn that was still open when its agent process ended: cut, not finished. */
export type AgentEndedOpenTurn = {
  /** The provider conversation it ran in; null for an agent whose hooks report none. */
  conversationId: string | null
  turnStartedAt: number
}

const MAX_REMEMBERED_ENDED_TURNS = 1024

/**
 * Per pane, the last turn its agent process ended mid-way. The pane's next row (a resumed or fresh
 * agent) overwrites the status row, never this, so a reader can still tell a turn that was cut from
 * one that ended. Written only at process end: a session boundary or a turn clock change is not
 * evidence of a cut. In memory: a restart before anything reads it leaves that turn unknown.
 */
export class AgentEndedOpenTurns {
  private readonly byPaneKey = new Map<string, AgentEndedOpenTurn>()

  record(paneKey: string, row: EnrichedAgentHookEventPayload | undefined): void {
    const state = row?.payload.mainAgent?.state ?? row?.payload.state
    if (!row || row.turnStartedAt === undefined || state === undefined || state === 'done') {
      return
    }
    this.byPaneKey.delete(paneKey)
    this.byPaneKey.set(paneKey, {
      conversationId: row.providerSession?.id ?? null,
      turnStartedAt: row.turnStartedAt
    })
    for (const oldest of this.byPaneKey.keys()) {
      if (this.byPaneKey.size <= MAX_REMEMBERED_ENDED_TURNS) {
        break
      }
      this.byPaneKey.delete(oldest)
    }
  }

  get(paneKey: string): AgentEndedOpenTurn | null {
    return this.byPaneKey.get(paneKey) ?? null
  }
}
