// Why: both screens show this code before the owner approves a GUI pairing. It is derived from the
// v2 transcript both peers already hold, so a man in the middle shows a different code.
export const PAIRING_COMPARISON_CODE_INFO = 'orca-pair-sas/v1'
export const PAIRING_COMPARISON_CODE_LENGTH = 6
// 6 base32 characters need 30 bits.
export const PAIRING_COMPARISON_CODE_BYTES = 4

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32 of the HKDF output, cut to the display length. */
export function formatPairingComparisonCode(okm: Uint8Array): string {
  let bits = 0
  let value = 0
  let code = ''
  for (const byte of okm) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5 && code.length < PAIRING_COMPARISON_CODE_LENGTH) {
      code += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (code.length < PAIRING_COMPARISON_CODE_LENGTH) {
    throw new Error('comparison code needs at least 30 bits')
  }
  return code
}

/** Accepts what a person types: case, spaces and dashes do not matter. */
export function normalizeTypedComparisonCode(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase()
}
