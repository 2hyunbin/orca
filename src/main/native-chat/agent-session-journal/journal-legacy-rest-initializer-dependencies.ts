import type { JournalHostDatabase } from './journal-host-database'
import type { readJournalRestFacts } from './journal-row-table'

export type JournalLegacyRestCandidate = { id: string; visible: boolean; updatedAt: number }

export type JournalLegacyRestInitializerDependencies = {
  database: JournalHostDatabase
  candidates: () => Iterable<string | JournalLegacyRestCandidate | undefined>
  /** Ordinary open can commit the pair before its cold unknown presentation completes. */
  needsPublication?: (sessionId: string) => boolean
  /** Null means an owner is still live/foreign/unproved; a stable value is its actual source guard. */
  owner: (sessionId: string) => string | null
  initialized: (
    sessionId: string,
    facts: NonNullable<ReturnType<typeof readJournalRestFacts>>
  ) => void
  failed: (sessionId: string, error: unknown) => void
}
