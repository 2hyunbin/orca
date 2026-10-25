import { readJournalRestFacts, readJournalSessionProjection } from './journal-row-table'
import type { LegacyRestSource } from './journal-legacy-rest-worker-protocol'

import type { JournalLegacyRestInitializerDependencies } from './journal-legacy-rest-initializer-dependencies'

export type LegacyRestDeps = JournalLegacyRestInitializerDependencies & {
  priority?: (sessionId: string) => { visible: boolean; updatedAt: number } | undefined
}

/** Only main derives live ownership and writes/publishes canonical status. */
export class LegacyRestSourceOwner {
  constructor(private readonly deps: LegacyRestDeps) {}
  source(sessionId: string): LegacyRestSource | null {
    const { db } = this.deps.database
    const projection = readJournalSessionProjection(db, sessionId)
    const owner = this.deps.owner(sessionId)
    if (!projection || owner === null) {
      return null
    }
    const known = projection.pair[0] !== null || projection.pair[1] === 0
    if (
      known
        ? !this.deps.needsPublication?.(sessionId)
        : projection.pair[0] !== null || projection.pair[1] !== null
    ) {
      return null
    }
    const tip = Number(
      db
        .prepare('SELECT MAX(seq) AS tip FROM journal_rows WHERE session_id = ? AND epoch = ?')
        .get(sessionId, projection.epoch)?.tip ?? 0
    )
    if (tip < 1) {
      return null
    }
    return {
      ...projection,
      known,
      tip,
      guard: JSON.stringify([6, sessionId, projection, tip, owner])
    }
  }

  publishKnown(sessionId: string, guard: string): void {
    const facts = readJournalRestFacts(this.deps.database.db, sessionId)
    if (facts?.known && this.source(sessionId)?.guard === guard) {
      this.deps.initialized(sessionId, facts)
    }
  }

  commit(
    sessionId: string,
    source: LegacyRestSource,
    fact: NonNullable<ReturnType<typeof readJournalRestFacts>>['openTurn']
  ): boolean {
    const committed = this.deps.database.transaction((db) => {
      if (this.source(sessionId)?.guard !== source.guard) {
        return false
      }
      const result = db
        .prepare(`UPDATE journal_sessions SET open_turn_id = ?, open_turn_since = ?
        WHERE session_id = ? AND epoch = ? AND open_turn_id IS NULL AND open_turn_since IS NULL
        AND (SELECT COALESCE(MAX(seq),0) FROM journal_rows WHERE session_id = ? AND epoch = ?) = ?`)
        .run(
          fact?.itemId ?? null,
          fact?.since ?? 0,
          sessionId,
          source.epoch,
          sessionId,
          source.epoch,
          source.tip
        )
      if (result.changes !== 1) {
        throw new Error('legacy projection CAS did not initialize its candidate')
      }
      return true
    })
    if (committed) {
      const facts = readJournalRestFacts(this.deps.database.db, sessionId)
      if (facts) {
        this.deps.initialized(sessionId, facts)
      }
    }
    return committed
  }
}
