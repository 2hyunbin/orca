import { describe, expect, it } from 'vitest'
import { createOmpAnswerRetryFence } from './native-chat-omp-answer-retry-fence'

describe('OMP answer retry fence', () => {
  it('retains attempted keys and fails closed when capacity is exhausted', () => {
    const fence = createOmpAnswerRetryFence()
    expect(fence.blocks('first')).toBe(false)
    fence.record('first')
    expect(fence.blocks('first')).toBe(true)
    expect(fence.blocks('next')).toBe(false)
    for (let i = 0; i < 200; i += 1) {
      fence.record(`attempt-${i}`)
    }
    expect(fence.blocks('first')).toBe(true)
    expect(fence.blocks('unseen')).toBe(true)
  })
})
