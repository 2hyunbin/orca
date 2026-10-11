import nacl from 'tweetnacl'
import type { PairedE2EEPrimitives } from '../../../shared/paired-e2ee-primitives'
import {
  decrypt,
  decryptBytes,
  deriveSharedKey,
  encrypt,
  encryptBytes,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from './web-e2ee'

export const WEB_PAIRED_E2EE_PRIMITIVES: PairedE2EEPrimitives = {
  generateKeyPair,
  deriveSharedKey,
  randomBytes: (length) => nacl.randomBytes(length),
  encodeBase64: publicKeyToBase64,
  decodeBase64: (value) => {
    const binary = window.atob(value)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  },
  publicKeyFromBase64,
  publicKeyToBase64,
  sealLegacyText: encrypt,
  openLegacyText: decrypt,
  sealLegacyBinary: encryptBytes,
  openLegacyBinary: decryptBytes
}
