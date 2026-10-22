import { selectTerminalMailHandoff, terminalMailHandoffCanSubmit } from './terminal-mail-settlement'
import { afterEach, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { readMailHandoff, type StructuredMailHandoff } from './mail-handoff'
import { selectStructuredMailHandoff, type StructuredMailEvidence } from './mailbox-settlement'
import type { TerminalMailTarget } from '../../agent-hooks/server/terminal-mail-target'

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})
function database() {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  return db
}

it('terminal failure recovery is reserved once, revalidated before Enter, and cannot suppress fresh mail', () => {
  const db = database()
  const message = db.insertMessage({ from: 'sender', to: 'consumer', subject: 'QA result' })
  const target: TerminalMailTarget = {
    paneKey: 'pane',
    process: { pid: 123, platform: 'linux', startTime: 'original-process' },
    owner: 'owner',
    turnKey: 'turn'
  }
  let abandoned = false
  const select = () =>
    selectTerminalMailHandoff({
      db,
      mailbox: 'consumer',
      target,
      wasAbandoned: () => abandoned,
      waiters: undefined,
      reservedTypes: undefined
    })
  expect(select().map((row) => row.id)).toEqual([message.id])
  db.markAsDelivered([message.id])
  expect(select()).toEqual([])
  abandoned = true
  const recovery = select()
  expect(recovery[0]?.recovery_used).toBe(1)
  const canSubmit = () => terminalMailHandoffCanSubmit(db, 'consumer', recovery, () => abandoned)
  expect(canSubmit()).toBe(true)
  abandoned = false
  expect(canSubmit()).toBe(false)
  abandoned = true
  db.recordUnknownMailRead(recovery)
  expect(canSubmit()).toBe(false)
  db.markAsDelivered([message.id])
  expect(select()).toEqual([])
  const fresh = db.insertMessage({ from: 'sender', to: 'consumer', subject: 'new result' })
  expect(select().map((row) => row.id)).toEqual([fresh.id])
})

it('rotating a never-admitted recovery transport preserves its original failed-owner authorization', async () => {
  const db = database()
  const message = db.insertMessage({ from: 'sender', to: 'consumer', subject: 'result' })
  const reference: StructuredMailHandoff = {
    version: 1,
    kind: 'structured',
    sessionId: 'session',
    epoch: 'epoch',
    frontier: 'prior-host',
    operationId: 'old-operation',
    authorizationId: 'one-recovery',
    clientMessageId: 'old-operation',
    phase: 'reserved',
    authority: db.mailboxHandoffAuthority('consumer'),
    nonAdmission: 'refused',
    recoverySource: 'original-failed-notice'
  }
  db.reserveMailHandoff('consumer', message, reference, true)
  const evidence: StructuredMailEvidence = {
    epoch: 'epoch',
    frontier: 'new-host',
    stopInForce: false,
    submission: undefined,
    owner: null,
    latestTurn: null,
    acceptedUnopened: false,
    personStopped: false,
    diedTurnId: null
  }
  const selected = await selectStructuredMailHandoff({
    db,
    mailbox: 'consumer',
    sessionId: 'session',
    epoch: 'epoch',
    frontier: 'new-host',
    waiters: undefined,
    reservedTypes: undefined,
    readEvidence: async () => evidence
  })
  expect(selected?.reference).toMatchObject({
    authorizationId: 'one-recovery',
    recoverySource: 'original-failed-notice'
  })
  expect(selected?.reference.operationId).not.toBe('old-operation')
  expect(db.getMessageById(message.id)?.recovery_used).toBe(1)
  expect(readMailHandoff(db.getMessageById(message.id)?.handoff)).toEqual(selected?.reference)
})
