import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { expect } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { structuredAgentSessionCommandTurnIdentity } from '../../../shared/structured-agent-session-command-turn-identity'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { openTestJournalHostDatabase } from './journal-host-database-test-support'
import { openAgentSessionJournal } from './journal-store-factory'
import { populationState } from './journal-population-owner-test-support'

/** Legal distinct attempts, refused real import and point reads over a retained legacy population. */
export async function exerciseSharedLegacyPopulation(
  root: string,
  count: number,
  measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T>
): Promise<void> {
  const database = openTestJournalHostDatabase(root)
  const sessionId = `shared-legacy-${count}`
  const refusal = agentSessionFailureWords(
    { kind: 'providerRejected' },
    { agentName: 'Codex', surface: 'rejection' }
  )
  const raw = 'shared-R'
  const rawAt = (index: number) => (index === 0 ? raw : `${raw}-${index}`)
  const body = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'shared raw' }]
  } as const
  const mutableBody = { ...body, blocks: [...body.blocks] }
  let clock = 1000
  const open = () =>
    openAgentSessionJournal({
      identity: {
        sessionId,
        workspaceId: 'workspace',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('shared-legacy-thread')
      },
      database,
      now: () => clock
    })
  let journal = await open()
  try {
    await measure('shared-legacy-seed', async () => {
      for (let index = 0; index < count; index++) {
        await journal.appendSubmission({
          clientMessageId: rawAt(index),
          fence: 1,
          body: mutableBody,
          queuedMessageId: `shared-card-${index}`,
          payloadFingerprint: agentSessionSendBodyFingerprint(sessionId, mutableBody)
        })
      }
      await journal.close()
      const insert = database.db.prepare(`INSERT INTO queued_messages
        (session_id,message_id,position,body_json,fingerprint,created_at,host_instance,state,
         hold_reason,returned_reason,returned_rejection,settled_at,settled_by_op,consumed_as,
         carried_from,queued_epoch,queued_sequence,options_json)
        VALUES(?,?,?,?,?,100,'shared-legacy','dispatched',NULL,NULL,NULL,NULL,NULL,?,NULL,NULL,NULL,NULL)`)
      for (let index = 0; index < count; index++) {
        insert.run(
          sessionId,
          `shared-card-${index}`,
          index + 1,
          JSON.stringify(mutableBody),
          agentSessionSendBodyFingerprint(sessionId, mutableBody),
          rawAt(index)
        )
      }
      database.db.exec(`CREATE TEMP TRIGGER fail_shared_legacy_import BEFORE INSERT ON journal_rows
        WHEN NEW.session_id = 'shared-legacy-${count}' AND json_extract(NEW.row_json,'$.kind') = 'queue'
        BEGIN SELECT RAISE(ABORT, 'shared legacy import refused'); END`)
    })
    const { current, state, queues, cards, key, normalization, attemptRevision, rawDependency } =
      await measure('shared-legacy-open', async () => {
        journal = await open()
        const current = journal
        const state = populationState(current)
        const queues = current.queuedMessages
        expect(
          database.db
            .prepare('SELECT COUNT(*) AS n FROM queued_messages WHERE session_id = ?')
            .get(sessionId)?.n
        ).toBe(count)
        expect(state.queue.cards.size).toBe(0)
        const cards = Array.from({ length: count }, (_, index) =>
          queues.get(`shared-card-${index}`)
        )
        expect(
          cards.every(
            (card, index) => card?.state === 'dispatched' && card.consumedAs === rawAt(index)
          )
        ).toBe(true)
        for (let index = 0; index < count; index++) {
          expect(current.submission(rawAt(index))?.queuedMessageId).toBe(`shared-card-${index}`)
          expect(state.selection.groups.has(`legacyRaw:${rawAt(index)}`)).toBe(true)
        }
        return {
          current,
          state,
          queues,
          cards,
          key: queues.revision(),
          normalization: queues.normalizationKey(),
          attemptRevision: state.selection.groups.revision('attempt:shared-card-0'),
          rawDependency: state.selection.storage
            .map<string, { rawSignature: string }>('submissionSources')
            .get(raw)!.rawSignature
        }
      })
    const assertUnchanged = () => {
      expect(queues.get('shared-card-0')).toEqual(cards[0])
      expect(queues.revision()).toBe(key)
      expect(queues.normalizationKey()).toBe(normalization)
      expect(
        state.selection.storage.map<string, { rawSignature: string }>('submissionSources').get(raw)
          ?.rawSignature
      ).toBe(rawDependency)
      expect(state.selection.groups.revision('attempt:shared-card-0')).toBe(attemptRevision)
    }
    await measure('shared-legacy-point', async () => {
      clock++
      await current.resolveDispatch({
        turnScope: AGENT_JOURNAL_THREAD_SCOPE,
        clientMessageId: raw,
        state: 'pending',
        fence: 2
      })
      assertUnchanged()
    })
    await measure('shared-legacy-series', async () => {
      for (let index = 0; index < count; index++) {
        clock++
        await current.resolveDispatch({
          turnScope: AGENT_JOURNAL_THREAD_SCOPE,
          clientMessageId: raw,
          state: 'pending',
          fence: 2
        })
        assertUnchanged()
      }
    })
    expect(Array.from({ length: count }, (_, index) => queues.get(`shared-card-${index}`))).toEqual(
      cards
    )
    expect(current.submission(raw)?.handedOverAt).toBe(clock)
    expect(current.submission(raw)?.fence).toBe(2)
    expect(current.submission(raw)?.handoverRecorded).toBeUndefined()
    const report = structuredAgentSessionCommandTurnIdentity(raw)
    expect(state.selection.groups.has(`legacyReport:${agentJournalItemKey(report)}`)).toBe(false)
    await measure('shared-legacy-noncommand-report', async () => {
      await current.appendItem(
        report,
        { kind: 'turn', turnId: 'shared-R', state: 'completed', outcome: 'failure' },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE, fence: 2 }
      )
      assertUnchanged()
    })
    expect(Array.from({ length: count }, (_, index) => queues.get(`shared-card-${index}`))).toEqual(
      cards
    )
    const reject = async (index: number) => {
      const before = queues.revision()
      clock++
      await current.resolveDispatch({
        clientMessageId: rawAt(index),
        state: 'rejected',
        fence: 2,
        ...refusal
      })
      const card = queues.get(`shared-card-${index}`)
      expect(card?.state).toBe('returned')
      expect(card).toEqual({
        ...cards[index],
        state: 'returned',
        returnedReason: refusal.reason,
        returnedRejection: refusal.rejection
      })
      expect(queues.revision()).not.toBe(before)
      expect(queues.normalizationKey()).toBe(normalization)
    }
    await measure('shared-legacy-relevant-point', () => reject(0))
    for (let index = 1; index < count; index++) {
      expect(queues.get(`shared-card-${index}`)).toEqual(cards[index])
    }
    await measure('shared-legacy-relevant', async () => {
      for (let index = 1; index < count; index++) {
        await reject(index)
      }
    })
    for (let index = 0; index < count; index++) {
      const card = queues.get(`shared-card-${index}`)
      expect(card).toEqual({
        ...cards[index],
        state: 'returned',
        returnedReason: refusal.reason,
        returnedRejection: refusal.rejection
      })
    }
    expect(queues.revision()).not.toBe(key)
    expect(queues.normalizationKey()).toBe(normalization)
    database.db.exec('DROP TRIGGER fail_shared_legacy_import')
  } finally {
    await journal.close()
  }
}
