import { describe, expect, it } from 'vitest'
import {
  formatPairingComparisonCode,
  normalizeTypedComparisonCode
} from '../../shared/pairing-comparison-code'
import { derivePairingComparisonCode as derivePureJs } from '../../shared/pairing-comparison-code-noble'
import { derivePairingComparisonCode as deriveNode } from './pairing-comparison-code-node'

const TRANSCRIPT_HASH = Uint8Array.from({ length: 32 }, (_, index) => index)

describe('pairing comparison code', () => {
  it('is a 6-character base32 code that host and client derive identically', () => {
    const code = deriveNode(TRANSCRIPT_HASH)
    expect(code).toMatch(/^[A-Z2-7]{6}$/)
    // Pinned vector: a change here desynchronizes every client's displayed code.
    expect(code).toBe('KMGVTD')
    expect(derivePureJs(TRANSCRIPT_HASH)).toBe(code)
  })

  it('changes with the transcript', () => {
    const other = Uint8Array.from(TRANSCRIPT_HASH)
    other[0] = 1
    expect(deriveNode(other)).not.toBe(deriveNode(TRANSCRIPT_HASH))
  })

  it('formats RFC 4648 base32 and ignores typing noise', () => {
    expect(formatPairingComparisonCode(new Uint8Array([0, 0, 0, 0]))).toBe('AAAAAA')
    expect(formatPairingComparisonCode(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toBe('777777')
    expect(normalizeTypedComparisonCode(' m4u-e6u ')).toBe('M4UE6U')
  })
})
