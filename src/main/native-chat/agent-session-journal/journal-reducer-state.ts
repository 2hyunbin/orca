import { JournalRestProjection } from './journal-rest-projection'
import { JournalDerivedTurnScope } from './journal-derived-turn-scope'
import { createJournalQueuePauseMarks } from './queued-message-pause'
import { createJournalQueueState } from './journal-queue-fold'
import type { JournalReducerState } from './journal-reducer'

export function createJournalReducerState(sessionId: string, epoch: string): JournalReducerState {
  return {
    rest: new JournalRestProjection(),
    sessionId,
    epoch,
    lastSequence: 0,
    lastActivityAt: 0,
    oldestSequence: 1,
    highestFence: 0,
    items: new Map(),
    itemFences: new Map(),
    itemExecutionOwners: new Map(),
    providerActivityAt: new Map(),
    tombstones: new Map(),
    removedTurnIds: new Set(),
    submissionVersion: 0,
    submissions: new Map(),
    receipts: new Map(),
    aliases: new Map(),
    itemEchoes: new Map(),
    appliedSettlementIds: new Set(),
    derivedTurnScope: new JournalDerivedTurnScope(),
    latestAcceptedTurnSequence: 0,
    queuePauseMarks: createJournalQueuePauseMarks(),
    stoppedHistoryCarried: new Map(),
    queuedHandOffPlaces: new Map(),
    normalizedHandOffs: new Set(),
    queue: createJournalQueueState(),
    historyOrigin: null
  }
}
