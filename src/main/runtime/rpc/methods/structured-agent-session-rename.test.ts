import { afterEach, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session-record.test-fixture'
import { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { abandonStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-abandon'
import {
  hostTestState,
  replaceHostTestState
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../../agent-session-record-store-test-harness'
import {
  call,
  clearStructuredHostStub,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

afterEach(clearStructuredHostStub)

it('filters naming notes by the same record audience as status rows', async () => {
  const rig = hostTestState()
  await abandonStructuredAgentSessionHost(rig.host)
  const records = ['session-codex', 'session-pi', 'session-raw-only'].map(
    (sessionId): AgentSessionRecord => {
      const record = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
      return {
        ...record,
        provider: sessionId === 'session-pi' ? 'pi' : 'codex',
        conversationName: 'Name',
        conversationNameSource: 'user',
        providerHandleChain: record.providerHandleChain.map((link) => ({
          ...link,
          handle: {
            transport: sessionId === 'session-pi' ? 'pi' : 'codex-app-server',
            agent: sessionId === 'session-pi' ? 'pi' : 'codex',
            nativeId: `provider-${sessionId}`
          }
        }))
      }
    }
  )
  await seedTestAgentSessionRecordStore(rig.root, { records })
  const database = openTestJournalHostDatabase(rig.root)
  database.db
    .prepare(
      "UPDATE agent_session_records SET record_json = json_set(record_json, '$.lease.minimumNextFence', 'bad') WHERE session_id = ?"
    )
    .run('session-codex')
  database.db
    .prepare(
      "UPDATE agent_session_records SET record_json = json_set(record_json, '$.providerHandleChain', 'invalid') WHERE session_id = ?"
    )
    .run('session-raw-only')
  const rawRows = database.db
    .prepare('SELECT session_id, record_json FROM agent_session_records ORDER BY session_id')
    .all()
  closeTestJournalHostDatabase(rig.root)
  const store = await openTestAgentSessionRecordStore(rig.root)
  const reopened = openTestJournalHostDatabase(rig.root)
  const host = new StructuredAgentSessionHost({
    ...rig.host.deps,
    store,
    journalDatabase: reopened
  })
  replaceHostTestState({ store, host })
  setStructuredAgentSessionHost(host)
  let closeStream = (): void => {}
  try {
    expect(database.isClosed).toBe(true)
    expect(store.getRecord('session-codex')).toBeNull()
    expect(store.getConversation('session-codex')).toMatchObject({
      provider: 'codex',
      conversationName: 'Name'
    })
    expect(() => store.requireWritableRecord('session-codex')).toThrowError(
      expect.objectContaining({
        refusal: expect.objectContaining({ details: { reason: 'recordUnreadable' } })
      })
    )
    expect(store.getConversation('session-pi')).toMatchObject({
      provider: 'pi',
      conversationName: 'Name'
    })
    expect(store.getConversation('session-raw-only')).toBeNull()
    expect(store.getConversation('session-missing')).toBeNull()
    expect(
      store
        .listConversations()
        .map((record) => record.sessionId)
        .sort()
    ).toEqual(['session-codex', 'session-pi'])
    expect(rawRows.map((row) => row.session_id)).toEqual([
      'session-codex',
      'session-pi',
      'session-raw-only'
    ])
    expect(reopened.db.prepare('SELECT session_id FROM journal_sessions').all()).toEqual([])
    expect(host.hasSession('session-codex')).toBe(false)
    expect(host.readStatusSummary('session-codex')).toBeUndefined()
    expect(
      await call('agentSession.subscribeStatus', null, STRUCTURED_CLIENT, {
        registerSubscriptionCleanup: (_id: string, cleanup: () => void) => {
          closeStream = cleanup
        }
      })
    ).toMatchObject({
      result: { conversationNames: [{ sessionId: 'session-codex', conversationName: 'Name' }] }
    })
    expect(host.hasSession('session-codex')).toBe(false)
    expect(host.readStatusSummary('session-codex')).toBeUndefined()
    expect(rig.acquire).not.toHaveBeenCalled()
    expect(rig.dispatch).not.toHaveBeenCalled()
    expect(
      reopened.db
        .prepare('SELECT session_id, record_json FROM agent_session_records ORDER BY session_id')
        .all()
    ).toEqual(rawRows)
    expect(reopened.db.prepare('SELECT session_id FROM journal_sessions').all()).toEqual([])
  } finally {
    closeStream()
    await abandonStructuredAgentSessionHost(host)
  }
})
