import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import {
  formatPairingComparisonCode,
  PAIRING_COMPARISON_CODE_BYTES,
  PAIRING_COMPARISON_CODE_INFO
} from './pairing-comparison-code'

// Why pure JS: browsers on plain http lack crypto.subtle. Keep it out of the CLI's unbundled graph.
export function derivePairingComparisonCode(transcriptHash: Uint8Array): string {
  return formatPairingComparisonCode(
    hkdf(
      sha256,
      transcriptHash,
      new Uint8Array(0),
      new TextEncoder().encode(PAIRING_COMPARISON_CODE_INFO),
      PAIRING_COMPARISON_CODE_BYTES
    )
  )
}
