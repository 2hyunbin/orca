import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { JournalLegacyRestInitializer } from './journal-legacy-rest-initializer'
import {
  JournalStructuralScratch,
  type JournalStructuralCheckpoint
} from './journal-structural-scratch'
import { openAgentSessionJournal } from './journal-store-factory'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { readJournalRestFacts } from './journal-row-table'

let root: string
const sessionId = 'legacy-upgrade'
const since = 1_800_000_000_000
const identity = (turnId: string) =>
  ({ provider: 'codex', threadId: 'thread', turnId, ordinal: 0 }) as const
const open = () =>
  openAgentSessionJournal({
    identity: {
      sessionId,
      workspaceId: 'workspace',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread')
    },
    database: openTestJournalHostDatabase(root),
    now: () => since
  })
const unknown = () =>
  openTestJournalHostDatabase(root)
    .db.prepare(
      'UPDATE journal_sessions SET open_turn_id = NULL, open_turn_since = NULL WHERE session_id = ?'
    )
    .run(sessionId)
const facts = () => readJournalRestFacts(openTestJournalHostDatabase(root).db, sessionId)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-legacy-rest-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

it.each([64, 640])(
  'resumes committed structural progress at %i rows, preserving aliases, creation order and raw keys',
  async (size) => {
    const journal = await open()
    await journal.appendItem(
      identity('older'),
      { kind: 'turn', turnId: 'older', state: 'completed', outcome: 'success' },
      { fence: 1 }
    )
    const rawId = '\0\ud800\nraw'
    const body = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'retained exact payload' }]
    } as const
    await journal.appendSubmission({
      clientMessageId: rawId,
      body,
      payloadFingerprint: agentSessionSendBodyFingerprint(sessionId, body),
      fence: 1,
      handoverRecorded: true
    })
    const echo = { ...identity('newer'), ordinal: 1 }
    await journal.appendItem(echo, body, { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    await journal.appendLifecycleBatch({
      settlementId: 'newer-cut',
      fence: 1,
      mutations: [
        {
          kind: 'item',
          identity: identity('newer'),
          body: {
            kind: 'turn',
            turnId: 'newer',
            userItemId: agentJournalItemKey(echo),
            startedAt: since,
            state: 'interrupted',
            outcome: 'cancellation'
          }
        }
      ]
    })
    await journal.appendItem(
      identity('older'),
      { kind: 'turn', turnId: 'older', state: 'completed', outcome: 'success' },
      { fence: 1 }
    )
    const command = { ...identity('compact'), ordinal: 1 }
    await journal.appendItem(
      command,
      {
        kind: 'message',
        role: 'user',
        command: { name: 'compact' },
        blocks: [{ type: 'text', text: '/compact' }]
      },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await journal.appendItem(
      identity('compact'),
      {
        kind: 'turn',
        turnId: 'compact',
        state: 'running',
        userItemId: agentJournalItemKey(command)
      },
      { fence: 1 }
    )
    await journal.appendItem(
      identity('compact'),
      { kind: 'status', text: 'compacted' },
      { fence: 1 }
    )
    await journal.appendLifecycleBatch({
      settlementId: 'temporary-turn',
      fence: 1,
      mutations: [
        {
          kind: 'item',
          identity: identity('removed'),
          body: { kind: 'turn', turnId: 'removed', state: 'running' }
        },
        { kind: 'tombstone', identity: identity('removed') }
      ]
    })
    await journal.appendItem(
      identity('nested'),
      { kind: 'turn', turnId: 'nested', state: 'running' },
      {
        fence: 1,
        agentId: 'helper',
        producerKind: 'subagent',
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    )
    for (let i = 0; i < size; i++) {
      await journal.appendItem(
        { ...identity('newer'), ordinal: 2 },
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `stream ${i}` }] },
        { fence: 1 }
      )
    }
    const tip = journal.cursor().sequence
    const expected = journal.restFact()
    expect(expected).toEqual({ itemId: agentJournalItemKey(identity('newer')), since })
    await journal.close()
    unknown()
    const failed = vi.fn()
    const published = vi.fn((_id, actual) => {
      expect(facts()).toEqual(actual)
    })
    const make = () =>
      new JournalLegacyRestInitializer({
        database: openTestJournalHostDatabase(root),
        candidates: () => [sessionId],
        owner: () => 'ended-fence-1',
        initialized: published,
        failed
      })
    let ready = 0
    const first = make()
    await first.advance(() => ++ready <= 2)
    expect(facts()?.known).toBe(false)
    first.close()
    const scratch = new JournalStructuralScratch(join(root, 'journal-rest-upgrade-scratch.db'))
    const checkpoint = scratch.load<JournalStructuralCheckpoint>()!
    expect(checkpoint.cursor).toBeGreaterThan(0)
    expect(checkpoint.cursor).toBeLessThan(size)
    expect(scratch.map('items').size).toBeGreaterThan(0)
    scratch.close()
    closeTestJournalHostDatabases()
    const database = openTestJournalHostDatabase(root)
    const prepare = database.db.prepare.bind(database.db)
    const reads: unknown[][] = []
    const sql = vi.spyOn(database.db, 'prepare').mockImplementation((query) => {
      const statement = prepare(query)
      if (query.includes('ORDER BY seq ASC LIMIT') && !vi.isMockFunction(statement.all)) {
        const all = statement.all.bind(statement)
        vi.spyOn(statement, 'all').mockImplementation((...args) => {
          reads.push(args)
          return all(...args)
        })
      }
      return statement
    })
    const resumed = make()
    await resumed.advance(() => true)
    expect(failed.mock.calls.map(([, error]) => error?.stack)).toEqual([])
    expect(published).toHaveBeenCalledOnce()
    expect(facts()?.openTurn).toEqual(expected)
    expect(reads[0]?.[2]).toBe(checkpoint.cursor)
    expect(reads.length).toBe(tip - checkpoint.cursor + 1)
    const count = reads.length
    await resumed.advance(() => true)
    expect(reads).toHaveLength(count)
    resumed.close()
    sql.mockRestore()
    const reopened = await open()
    expect(reopened.restFact()).toEqual(expected)
    expect(reopened.submission(rawId)?.providerItemId).toBe(agentJournalItemKey(echo))
    await reopened.close()
  }
)

it.each(['owner', 'tip', 'pair', 'epoch', 'core-failure', 'newer', 'gap'])(
  'leaves newer authority and unsupported/failed evidence untouched: %s',
  async (race) => {
    const journal = await open()
    await journal.appendItem(
      identity('cut'),
      { kind: 'turn', turnId: 'cut', state: 'running', startedAt: since },
      { fence: 1 }
    )
    await journal.close()
    unknown()
    const database = openTestJournalHostDatabase(root)
    let owner: string | null = 'ended'
    const publish = vi.fn()
    const failed = vi.fn()
    const initializer = new JournalLegacyRestInitializer({
      database,
      candidates: () => [sessionId],
      owner: () => owner,
      initialized: publish,
      failed
    })
    const transaction = database.transaction.bind(database)
    if (race === 'core-failure') {
      vi.spyOn(database, 'transaction').mockImplementationOnce((run) =>
        transaction((db) => {
          run(db)
          throw new Error('failed COMMIT')
        })
      )
    }
    if (race === 'newer') {
      database.db
        .prepare(
          "UPDATE journal_rows SET row_json = json_set(row_json, '$.v', 999) WHERE session_id = ? AND seq = 2"
        )
        .run(sessionId)
    }
    if (race === 'gap') {
      database.db
        .prepare('DELETE FROM journal_rows WHERE session_id = ? AND seq = 1')
        .run(sessionId)
    }
    let checks = 0
    await initializer.advance(() => {
      if (++checks === 2) {
        if (race === 'owner') {
          owner = null
        }
        if (race === 'tip') {
          database.db
            .prepare('DELETE FROM journal_rows WHERE session_id = ? AND seq = 2')
            .run(sessionId)
        }
        if (race === 'epoch') {
          database.db
            .prepare('UPDATE journal_sessions SET epoch = ? WHERE session_id = ?')
            .run('replacement-wins', sessionId)
        }
        if (race === 'pair') {
          database.db
            .prepare('UPDATE journal_sessions SET open_turn_since = 0 WHERE session_id = ?')
            .run(sessionId)
        }
      }
      return true
    })
    initializer.close()
    expect(publish).not.toHaveBeenCalled()
    expect(facts()?.known).toBe(race === 'pair')
    if (['core-failure', 'newer', 'gap'].includes(race)) {
      expect(failed).toHaveBeenCalledOnce()
    }
  }
)
