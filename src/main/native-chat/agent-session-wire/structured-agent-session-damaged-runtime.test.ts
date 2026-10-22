import { afterEach, expect, it } from 'vitest'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { admitAndRunAgentSessionMutation } from './structured-agent-session-mutation-admission'
import { setOptionPlan } from './structured-agent-session-mutation-plans'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig | undefined
let restored: StructuredAgentSessionHost | undefined
afterEach(async () => {
  await restored?.flushAllStreamedEvents()
  await rig?.dispose()
})

it('replays a saved send and its conflict but refuses fresh send, Stop and metadata before any new work', async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
  const body = hostTestMessage('saved message')
  const envelope = rig.envelope({ body }, 'agentSession.send', hostTestOperationId())
  const params = { envelope, body, userSend: true as const }
  const accepted = await rig.host.send(CALLER, params)
  expect(accepted).toMatchObject({ ok: true })
  expect(
    rig.store.readCommandReceipt({ kind: 'global' }, envelope.clientOperationId)
  ).toMatchObject({ verdict: 'readable' })
  await rig.host.flushAllStreamedEvents()
  damageFloor(rig.root)
  const store = await openTestAgentSessionRecordStore(rig.root)
  expect(store.readCommandReceipt({ kind: 'global' }, envelope.clientOperationId)).toMatchObject({
    verdict: 'readable'
  })
  restored = new StructuredAgentSessionHost({ ...rig.host.deps, store })
  const starts = rig.starts.mock.calls.length
  const sends = rig.dispatch.mock.calls.length
  expect(await restored.revealSession(SESSION)).toMatchObject({ sessionId: SESSION })
  expect(await restored.send(CALLER, params)).toMatchObject({
    ok: true,
    replayed: true,
    fence: store.getConversation(SESSION)?.currentFence,
    value: { clientMessageId: envelope.clientOperationId }
  })
  const changed = hostTestMessage('different message')
  expect(
    await restored.send(CALLER, {
      ...params,
      body: changed,
      envelope: rig.envelope({ body: changed }, 'agentSession.send', envelope.clientOperationId)
    })
  ).toMatchObject({ ok: false, refusal: { code: 'agent_session_operation_conflict' } })
  expect(
    await restored.send(CALLER, {
      ...params,
      envelope: rig.envelope({ body }, 'agentSession.send', hostTestOperationId())
    })
  ).toMatchObject({ ok: false, refusal: { details: { reason: 'recordUnreadable' } } })
  expect(
    await restored.cancel(CALLER, {
      envelope: rig.envelope({}, 'agentSession.cancel', hostTestOperationId())
    })
  ).toMatchObject({ ok: false, refusal: { details: { reason: 'recordUnreadable' } } })
  await expect(store.setConversationName(SESSION, 'changed')).rejects.toMatchObject({
    refusal: { details: { reason: 'recordUnreadable' } }
  })
  expect(rig.starts).toHaveBeenCalledTimes(starts)
  expect(rig.dispatch).toHaveBeenCalledTimes(sends)
  expect((await restored.journalSnapshot(SESSION)).submissions).toHaveLength(1)
})

it('answers a recorded ledger result without a preparation hook before requiring fresh authority', async () => {
  rig = await createQueuedMessageTestRig()
  const fields = { key: 'model', value: 'gpt-5' }
  const envelope = rig.envelope(fields, 'agentSession.setOption', hostTestOperationId())
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const request = {
    ...rig.host.deps,
    callerKey: CALLER.callerKey,
    envelope,
    plan: setOptionPlan(fields),
    journal: () => journal,
    publish: () => {},
    now: () => 1800000000000
  }
  expect(await admitAndRunAgentSessionMutation(request)).toMatchObject({ ok: true })
  damageFloor(rig.root)
  const store = await openTestAgentSessionRecordStore(rig.root)
  expect(await admitAndRunAgentSessionMutation({ ...request, store })).toMatchObject({
    ok: true,
    replayed: true,
    value: fields
  })
})

function damageFloor(root: string): void {
  openTestJournalHostDatabase(root)
    .db.prepare(
      "UPDATE agent_session_records SET record_json = json_set(record_json, '$.lease.minimumNextFence', 'bad') WHERE session_id = ?"
    )
    .run(SESSION)
}
