import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { openSecret, sealSecret } from './slack-sealing.js'

describe('secret sealing', () => {
  it('opens only with the same key, purpose and row', () => {
    const key = randomBytes(32)
    const sealed = sealSecret(key, 'slack-bot-token', ['T1', 'A1'], 'xoxb-secret')
    expect(sealed).not.toContain('xoxb')
    expect(openSecret(key, 'slack-bot-token', ['T1', 'A1'], sealed)).toBe('xoxb-secret')
    expect(() => openSecret(key, 'slack-bot-token', ['T2', 'A1'], sealed)).toThrow()
    expect(() => openSecret(key, 'slack-bot-token', ['T1', 'A2'], sealed)).toThrow()
    expect(() => openSecret(key, 'slack-signing-secret', ['T1', 'A1'], sealed)).toThrow()
    expect(() => openSecret(randomBytes(32), 'slack-bot-token', ['T1', 'A1'], sealed)).toThrow()
  })

  it('keeps the binding parts apart', () => {
    const key = randomBytes(32)
    const sealed = sealSecret(key, 'slack-signing-secret', ['A1'], 's')
    expect(() => openSecret(key, 'slack-signing-secret', ['A', '1'], sealed)).toThrow()
  })
})
