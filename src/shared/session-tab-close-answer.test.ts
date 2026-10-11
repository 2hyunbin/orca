import { describe, expect, it } from 'vitest'
import { sessionTabCloseAnswerOutcome } from './session-tab-close-answer'

describe('sessionTabCloseAnswerOutcome', () => {
  it.each([
    undefined,
    null,
    {},
    { closed: true },
    { refused: false },
    { refused: 'true', snapshotRepublished: true }
  ])('accepts legacy success and non-literal refusals: %j', (answer) => {
    expect(sessionTabCloseAnswerOutcome(answer)).toBe('closed')
  })

  it.each([
    'missing-intent',
    'stale-publication',
    'stale-terminal',
    'unknown-liveness',
    'future-reason',
    undefined
  ])('restores a refused close without a republish marker: %s', (refusalReason) => {
    expect(sessionTabCloseAnswerOutcome({ refused: true, refusalReason })).toBe('failed')
  })

  it.each(['live-host-pty', 'retirement-owner'])(
    'keeps a deliberately omitted lifecycle surface hidden: %s',
    (refusalReason) => {
      expect(sessionTabCloseAnswerOutcome({ refused: true, refusalReason })).toBe('closed')
      expect(
        sessionTabCloseAnswerOutcome({ refused: true, refusalReason, snapshotRepublished: 'true' })
      ).toBe('closed')
      expect(
        sessionTabCloseAnswerOutcome({ refused: true, refusalReason, snapshotRepublished: true })
      ).toBe('failed')
    }
  )
})
