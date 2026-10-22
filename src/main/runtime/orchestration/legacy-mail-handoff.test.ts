import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { drainLegacyMailHandoff } from './legacy-mail-handoff'
import { readMailHandoff } from './mail-handoff'
import { selectStructuredMailHandoff, type StructuredMailEvidence } from './mailbox-settlement'

it.each(['accepted', 'rejected'] as const)(
  'upgrades a legacy %s notice without suppressing unrelated pre-upgrade mail',
  async (dispatchState) => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-mail-handoff-upgrade-'))
    const path = join(directory, 'orchestration.db')
    let db = new OrchestrationDb(path)
    try {
      const member = db.insertMessage({ from: 'sender', to: 'consumer', subject: 'old' })
      const fresh = db.insertMessage({ from: 'sender', to: 'consumer', subject: 'new' })
      db.putStructuredPointerOperation({
        mailbox_handle: 'consumer',
        session_id: 'session',
        operation_id: 'legacy-operation',
        batch_fingerprint: 'legacy-fingerprint',
        minted_at_ms: 1
      })
      db.db.pragma('user_version = 43')
      db.close()
      db = new OrchestrationDb(path)
      const evidence: StructuredMailEvidence = {
        epoch: 'epoch',
        frontier: 'new-host',
        stopInForce: false,
        submission: {
          clientMessageId: 'legacy-operation',
          fence: 1,
          payloadFingerprint: 'payload',
          dispatchState,
          providerItemId: null,
          reason: 'provider_write_failed',
          submittedAt: 1,
          resolvedAt: 2
        },
        owner: null,
        latestTurn: null,
        acceptedUnopened: false,
        personStopped: false,
        diedTurnId: null,
        legacyNotice: {
          message: 'mail-notice',
          mailbox: 'consumer',
          dispatchId: null,
          messages: [{ messageId: member.id, runId: member.run_id, from: member.from_handle }]
        }
      }
      drainLegacyMailHandoff(db, db.getStructuredPointerOperation('consumer')!, evidence)
      expect(db.getStructuredPointerOperation('consumer')).toBeUndefined()
      expect(db.getMessageById(fresh.id)?.handoff).toBeNull()
      expect(readMailHandoff(db.getMessageById(member.id)?.handoff)).toMatchObject(
        dispatchState === 'accepted'
          ? { kind: 'unknown' }
          : { kind: 'structured', operationId: 'legacy-operation', nonAdmission: 'refused' }
      )
      const select = () =>
        selectStructuredMailHandoff({
          db,
          mailbox: 'consumer',
          sessionId: 'session',
          epoch: 'epoch',
          frontier: 'new-host',
          waiters: undefined,
          reservedTypes: undefined,
          readEvidence: async () => evidence
        })
      const batch = await select()
      expect(batch?.messages.map((row) => row.id)).toEqual([fresh.id])
      db.markAsRead([fresh.id])
      const remaining = await select()
      if (dispatchState === 'accepted') {
        expect(remaining).toBeNull()
      } else {
        expect(remaining?.reference.authorizationId).toBe('legacy-operation')
        expect(remaining?.reference.operationId).not.toBe('legacy-operation')
        expect(db.getMessageById(member.id)?.recovery_used).toBe(0)
      }
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
