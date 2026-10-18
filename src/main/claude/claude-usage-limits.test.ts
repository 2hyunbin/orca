import { describe, expect, it, vi } from 'vitest'
import { assistantFrame, frame, setup, userFrame } from './claude-context-usage-test-support'

// Seconds, as Claude sends them; two hours out so no reset passes mid-test.
const RESETS_AT_S = Math.floor(Date.now() / 1000) + 2 * 3600

const rateLimitEvent = (status: string, at: number) =>
  frame(
    {
      type: 'rate_limit_event',
      uuid: `rate-${at}`,
      rate_limit_info: { status, rateLimitType: 'five_hour', resetsAt: RESETS_AT_S }
    },
    at
  )

const refusedFrame = (uuid: string, at: number, text: string) =>
  frame(
    {
      type: 'assistant',
      uuid,
      user_message_uuid: `ask-${uuid}`,
      error: 'rate_limit',
      is_api_error_message: true,
      message: { role: 'assistant', content: [{ type: 'text', text }] }
    },
    at
  )

const failedResult = (uuid: string, at: number, text: string) =>
  frame(
    {
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: text,
      uuid: `result-${uuid}`,
      user_message_uuid: `ask-${uuid}`,
      duration_ms: 10
    },
    at
  )

const LIMIT_TEXT = "You've hit your limit · resets 3pm"

function statusRows(t: ReturnType<typeof setup>) {
  return t.items().flatMap((item) => (item.body.kind === 'status' ? [item.body] : []))
}

function messageTexts(t: ReturnType<typeof setup>): string[] {
  return t
    .items()
    .flatMap((item) =>
      item.body.kind === 'message'
        ? item.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        : []
    )
}

describe('a Claude usage limit', () => {
  it('ends the turn on one limit row, again when the CLI does not repeat the rejection', () => {
    const t = setup()
    t.handle(userFrame('turn-a', 1_000))
    t.handle(rateLimitEvent('rejected', 1_100))
    t.handle(assistantFrame('first', 1_150, 20))
    t.handle(frame({
      ...refusedFrame('a', 1_200, LIMIT_TEXT).message,
      user_message_uuid: undefined,
      api_error: 'usage_limit_reached'
    }, 1_200))
    t.handle(failedResult('a', 1_300, 'Request failed'))
    // The CLI throttles an unchanged rejection: the next turn carries none.
    t.handle(userFrame('turn-b', 2_000))
    t.handle(refusedFrame('b', 2_200, LIMIT_TEXT))
    t.handle(failedResult('b', 2_300, LIMIT_TEXT))

    const limitRow = {
      kind: 'status',
      tone: 'warning',
      text: 'Claude hit its session limit. Send a message once it resets to continue.',
      failure: {
        kind: 'usageLimitReached',
        usageLimit: { window: 'session', resetsAt: RESETS_AT_S * 1000 },
        detail: { text: LIMIT_TEXT, audience: 'person' }
      }
    }
    expect(statusRows(t)).toEqual([limitRow, limitRow])
    expect(messageTexts(t)).not.toContain(LIMIT_TEXT)
    t.translator.dispose()
  })

  it('keeps typed other causes and replacement turns separate from the account snapshot', () => {
    const t = setup()
    t.handle(userFrame('limited', 1_000))
    t.handle(rateLimitEvent('rejected', 1_100))
    t.handle(refusedFrame('limited', 1_200, LIMIT_TEXT))
    // No result: a replacement turn must not inherit the previous refusal.
    t.handle(userFrame('credits', 2_000))
    t.handle(frame({
      ...refusedFrame('credits', 2_100, 'This model requires usage credits').message,
      api_error: 'model_requires_usage_credits'
    }, 2_100))
    t.handle(frame({
      ...failedResult('credits', 2_200, 'This model requires usage credits').message,
      terminal_reason: 'blocking_limit', api_error_status: 429
    }, 2_200))
    expect(statusRows(t).filter((row) => row.failure?.kind === 'usageLimitReached')).toHaveLength(1)
    expect(statusRows(t).some((row) => row.text.includes('requires usage credits'))).toBe(true)
    t.translator.dispose()
  })

  it('keeps an explicit quota cause without metadata and expires snapshot inference', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(RESETS_AT_S * 1000 - 1000)
    try {
      const t = setup()
      t.handle(userFrame('typed', 1000))
      t.handle(frame({ ...refusedFrame('typed', 1100, LIMIT_TEXT).message,
        api_error: 'usage_limit_reached' }, 1100))
      t.handle(failedResult('typed', 1200, LIMIT_TEXT))
      t.handle(rateLimitEvent('rejected', 1300))
      clock.mockReturnValue(RESETS_AT_S * 1000 + 1000)
      t.handle(userFrame('expired', 2000))
      t.handle(refusedFrame('expired', 2100, 'Request rejected'))
      t.handle(failedResult('expired', 2200, 'Request rejected'))
      const limits = statusRows(t).filter((row) => row.failure?.kind === 'usageLimitReached')
      expect(limits).toHaveLength(1)
      expect(limits[0]?.failure?.usageLimit).toBeUndefined()
      t.translator.dispose()
    } finally {
      clock.mockRestore()
    }
  })

  it('leaves a throttle once the limit allows requests again', () => {
    const t = setup()
    t.handle(rateLimitEvent('rejected', 1_100))
    t.handle(rateLimitEvent('allowed_warning', 1_500))
    t.handle(userFrame('turn-a', 2_000))
    t.handle(refusedFrame('a', 2_200, 'API Error: Request rejected (429)'))
    t.handle(failedResult('a', 2_300, 'API Error: Request rejected (429)'))

    expect(statusRows(t).map((row) => row.failure?.kind)).not.toContain('usageLimitReached')
    expect(statusRows(t)).toContainEqual(
      expect.objectContaining({ tone: 'error', text: 'API Error: Request rejected (429)' })
    )
    t.translator.dispose()
  })
})
