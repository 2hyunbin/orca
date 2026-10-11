import { sha256 } from '@noble/hashes/sha256'

/** A short, readable fingerprint of a server's pairing key: the first 8 bytes of its sha256. */
export function pairingHostKeyFingerprint(publicKeyB64: string): string {
  const key = Uint8Array.from(atob(publicKeyB64), (character) => character.charCodeAt(0))
  const hex = Array.from(sha256(key).slice(0, 8), (byte) => byte.toString(16).padStart(2, '0'))
  return hex.join('').replace(/(.{4})(?=.)/g, '$1 ')
}
