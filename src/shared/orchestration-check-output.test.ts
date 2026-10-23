import { describe, expect, it, vi } from 'vitest'
import {
  formatOrchestrationCheckText,
  prepareOrchestrationCheckOutput
} from './orchestration-check-output'

describe('prepareOrchestrationCheckOutput', () => {
  it('escapes a long message body without decomposing it into characters', () => {
    const body = `${'Result 🐋 café '.repeat(8192)}\n\x1b[31mDone\x07\x9f`
    const original = String.prototype[Symbol.iterator]
    let iteratedCharacters = 0
    const spy = vi.spyOn(String.prototype, Symbol.iterator).mockImplementation(function (
      this: string
    ) {
      if (this === body) {
        iteratedCharacters += this.length
      }
      return original.call(this)
    })
    let formatted: string | undefined
    try {
      formatted = prepareOrchestrationCheckOutput(
        {
          count: 1,
          formatted: '',
          messages: [
            { id: 'msg_legacy', delivery_contract: 'audit_only', from_handle: 'worker', body }
          ]
        },
        'term_coord',
        true
      ).formatted
    } finally {
      spy.mockRestore()
    }
    expect(formatted).toContain(
      `[body]\n  ${'Result 🐋 café '.repeat(8192)}\n  \\x1b[31mDone\\x07\\x9f`
    )
    expect(iteratedCharacters).toBe(0)
  })

  it('keeps mixed read-only mail safe and current Run replies executable', () => {
    const prepared = prepareOrchestrationCheckOutput(
      {
        count: 2,
        messages: [
          {
            id: 'msg_current',
            run_id: 'run_adopted',
            delivery_contract: 'current_delivery',
            from_handle: 'term_worker',
            to_handle: 'run:run_adopted',
            subject: 'Question'
          },
          {
            id: 'msg_legacy',
            run_id: 'run_legacy_local',
            delivery_contract: 'audit_only',
            from_handle: 'term_legacy',
            to_handle: 'term_coord',
            subject: 'Old reply'
          }
        ],
        formatted: '[Reply: unsafe stale formatter output]'
      },
      'term_current_coord',
      true
    )

    expect(prepared.formatted).toContain(
      '[Reply: orca orchestration reply --id msg_current --body "..."]'
    )
    expect(prepared.formatted).not.toContain('--from run:run_adopted')
    expect(prepared.formatted).toContain(
      '[Inspection only: reply and acknowledgment are unavailable.]'
    )
    expect(prepared.formatted).not.toContain('unsafe stale formatter output')
  })
})

describe('formatted delivery acknowledgment', () => {
  it('retains the delivery ID above formatted message bodies', () => {
    expect(
      formatOrchestrationCheckText(
        {
          messages: [{ id: 'msg_one', from_handle: 'worker' }],
          count: 1,
          deliveryId: 'delivery_one',
          formatted: 'Message body'
        },
        'term_coord'
      )
    ).toBe('Delivery delivery_one\nMessage body')
  })
})
