import { describe, expect, it } from 'vitest'
import { structuredMailSource } from './structured-mail-source'

describe('who delivered mail is from', () => {
  it('bounds a snapshot name, and a naming failure costs only the name', () => {
    const named = (senderName: (party: unknown) => string | null) =>
      structuredMailSource({
        db: null,
        mailboxHandle: 'run:r1',
        dispatchId: null,
        message: { id: 'm1', from_handle: 'term_a', run_id: 'r1', type: 'status', payload: null },
        senderName
      }).senders[0]?.name
    expect(named(() => `  Build\n${'x'.repeat(400)}`)).toHaveLength(200)
    expect(named(() => '   ')).toBeNull()
    expect(
      named(() => {
        throw new Error('records unavailable')
      })
    ).toBeNull()
  })
})
