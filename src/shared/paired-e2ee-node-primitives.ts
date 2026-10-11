import nacl from 'tweetnacl'
import {
  decrypt,
  decryptBytes,
  deriveSharedKey,
  encrypt,
  encryptBytes,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from './e2ee-crypto'
import type { PairedE2EEPrimitives } from './paired-e2ee-primitives'

export const NODE_PAIRED_E2EE_PRIMITIVES: PairedE2EEPrimitives = {
  generateKeyPair,
  deriveSharedKey,
  randomBytes: (length) => nacl.randomBytes(length),
  encodeBase64: (bytes) => Buffer.from(bytes).toString('base64'),
  decodeBase64: (value) => Uint8Array.from(Buffer.from(value, 'base64')),
  publicKeyFromBase64,
  publicKeyToBase64,
  sealLegacyText: encrypt,
  openLegacyText: decrypt,
  sealLegacyBinary: encryptBytes,
  openLegacyBinary: decryptBytes
}
