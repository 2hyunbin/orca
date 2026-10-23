import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_PROMPT_BYTES,
  structuredAgentSessionBlocksTooLarge
} from './structured-agent-session-message-params'

afterEach(() => {
  vi.restoreAllMocks()
})

// Clients refuse before Send with words, so they must refuse exactly what a host refuses, including
// older hosts, which measure with Buffer.byteLength.
describe('message size bound', () => {
  const envelope = JSON.stringify([{ type: 'text', text: '' }]).length

  it('accepts a large message without scanning code units in JavaScript', () => {
    const blocks = [{ type: 'text', text: 'é'.repeat(100_000) }]
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt')

    const tooLarge = structuredAgentSessionBlocksTooLarge(blocks)
    const scannedCodeUnits = charCodeAt.mock.calls.length

    expect(tooLarge).toBe(false)
    expect(scannedCodeUnits).toBe(0)
  })

  it.each([
    ['ASCII', 'a', 1],
    ['multi-byte', 'é', 2],
    ['astral', '😀', 4]
  ])('agrees with the host at the boundary for %s text', (_name, unit, unitBytes) => {
    const fits = unit.repeat(Math.floor((MAX_PROMPT_BYTES - envelope) / unitBytes))
    for (const text of [fits, `${fits}${unit}`]) {
      const blocks = [{ type: 'text', text }]
      const hostRefuses = Buffer.byteLength(JSON.stringify(blocks), 'utf8') > MAX_PROMPT_BYTES
      expect(structuredAgentSessionBlocksTooLarge(blocks)).toBe(hostRefuses)
    }
  })
})
