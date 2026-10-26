import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupConnectorHarnesses,
  createConnectorHarness
} from './connector-server-harness.test-fixture.js'
import { saveCheckpoint, takeCheckpoint } from './discord-gateway-checkpoint.js'

afterEach(cleanupConnectorHarnesses)

const checkpoint = (sessionId: string, sequence: number) => ({
  sessionId,
  resumeURL: 'wss://gateway.example/resume',
  sequence
})

describe('Discord gateway checkpoint', () => {
  it('resumes where the last leader committed, and fences that leader once a successor starts', async () => {
    const { database, now } = await createConnectorHarness()
    const first = await takeCheckpoint(database, now())
    expect(first.resumeFrom).toBeNull()
    await database.transaction((transaction) =>
      saveCheckpoint(transaction, first.epoch, checkpoint('session-1', 4), now())
    )
    const second = await takeCheckpoint(database, now())
    expect(second.resumeFrom).toEqual(checkpoint('session-1', 4))
    // The old leader's routing shares the transaction, so it rolls back with the refused save.
    await expect(
      database.transaction(async (transaction) => {
        await saveCheckpoint(transaction, first.epoch, checkpoint('session-1', 9), now())
        await transaction.query(
          "INSERT INTO connector_seen (source, message_key, seen_at) VALUES ('discord', 'k', 1)"
        )
      })
    ).rejects.toThrow('a newer leader holds the Discord gateway')
    expect(await database.query('SELECT * FROM connector_seen')).toEqual([])
    expect((await takeCheckpoint(database, now())).resumeFrom).toEqual(checkpoint('session-1', 4))
  })
})
