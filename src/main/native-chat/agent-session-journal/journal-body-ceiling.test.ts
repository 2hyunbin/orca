import { describe, expect, it } from 'vitest'
import { journalBodyWithinCeiling } from './journal-body-ceiling'
import { JOURNAL_PAYLOAD_MAX_BYTES } from './journal-payload-bounds'

describe('journal body ceiling', () => {
  it('keeps the head and tail of a text past the ceiling, and leaves the rest alone', () => {
    const text = `start${'x'.repeat(JOURNAL_PAYLOAD_MAX_BYTES)}end`
    const body = {
      kind: 'tool-call',
      input: { command: 'cat huge.log' },
      output: { head: text, byteLength: text.length, digest: 'd', truncated: false }
    }

    const kept = journalBodyWithinCeiling(body)

    expect(kept.input).toBe(body.input)
    expect(kept.output.truncated).toBe(true)
    expect(kept.output.byteLength).toBe(text.length)
    expect(kept.output.head.startsWith('start')).toBe(true)
    expect(kept.output.head.endsWith('end')).toBe(true)
    expect(Buffer.byteLength(kept.output.head, 'utf8')).toBeLessThan(
      JOURNAL_PAYLOAD_MAX_BYTES + 1024
    )
    const small = { kind: 'message', blocks: [{ type: 'text', text: 'a'.repeat(1024) }] }
    expect(journalBodyWithinCeiling(small)).toBe(small)
  })
})
