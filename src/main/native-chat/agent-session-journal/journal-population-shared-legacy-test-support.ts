import { expect } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { structuredAgentSessionCommandTurnIdentity } from '../../../shared/structured-agent-session-command-turn-identity'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { openTestJournalHostDatabase } from './journal-host-database-test-support'
import { openAgentSessionJournal } from './journal-store-factory'
import { populationState } from './journal-population-owner-test-support'

/** Same raw owner, refused real open import, real pending dispatch and actual queue point reads. */
export async function exerciseSharedLegacyPopulation(
  root: string,
  count: number,
  measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T>
): Promise<void> {
  const database = openTestJournalHostDatabase(root)
  const sessionId = `shared-legacy-${count}`
  const raw = 'shared-R'
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
    await journal.appendSubmission({
      clientMessageId: raw,
      fence: 1,
      body: mutableBody,
      queuedMessageId: 'shared-card-0',
      payloadFingerprint: agentSessionSendBodyFingerprint(sessionId, mutableBody)
    })
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
        raw
      )
    }
    database.db.exec(`CREATE TEMP TRIGGER fail_shared_legacy_import BEFORE INSERT ON journal_rows
      WHEN NEW.session_id = 'shared-legacy-${count}' AND json_extract(NEW.row_json,'$.kind') = 'queue'
      BEGIN SELECT RAISE(ABORT, 'shared legacy import refused'); END`)
    journal = await measure('shared-legacy-open', open)
    const current = journal
    const state = populationState(current)
    const queues = current.queuedMessages
    expect(
      database.db
        .prepare('SELECT COUNT(*) AS n FROM queued_messages WHERE session_id = ?')
        .get(sessionId)?.n
    ).toBe(count)
    expect(state.queue.cards.size).toBe(0)
    const cards = Array.from({ length: count }, (_, index) => queues.get(`shared-card-${index}`))
    expect(cards.every((card) => card?.state === 'dispatched' && card.consumedAs === raw)).toBe(
      true
    )
    expect(state.selection.groups.has(`legacyRaw:${raw}`)).toBe(true)
    const key = queues.revision()
    const normalization = queues.normalizationKey()
    const attemptRevision = state.selection.groups.revision('attempt:shared-card-0')
    const rawDependency = state.selection.storage
      .map<string, { rawSignature: string }>('submissionSources')
      .get(raw)!.rawSignature
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
      await current.resolveDispatch({ clientMessageId: raw, state: 'pending', fence: 2 })
      assertUnchanged()
    })
    await measure('shared-legacy-series', async () => {
      for (let index = 0; index < count; index++) {
        clock++
        await current.resolveDispatch({ clientMessageId: raw, state: 'pending', fence: 2 })
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
        { fence: 2 }
      )
      assertUnchanged()
    })
    expect(Array.from({ length: count }, (_, index) => queues.get(`shared-card-${index}`))).toEqual(
      cards
    )
    await measure('shared-legacy-relevant', async () => {
      clock++
      await current.resolveDispatch({
        clientMessageId: raw,
        state: 'rejected',
        fence: 2,
        reason: 'shared content refused'
      })
      expect(queues.get('shared-card-0')?.state).toBe('returned')
    })
    for (let index = 0; index < count; index++) {
      const card = queues.get(`shared-card-${index}`)
      expect(card).toEqual({
        ...cards[index],
        state: 'returned',
        returnedReason: 'shared content refused'
      })
    }
    expect(queues.revision()).not.toBe(key)
    expect(queues.normalizationKey()).toBe(normalization)
    database.db.exec('DROP TRIGGER fail_shared_legacy_import')
  } finally {
    await journal.close()
  }
}
