import { hkdfSync } from 'node:crypto'
import {
  formatPairingComparisonCode,
  PAIRING_COMPARISON_CODE_BYTES,
  PAIRING_COMPARISON_CODE_INFO
} from '../../shared/pairing-comparison-code'

export function derivePairingComparisonCode(transcriptHash: Uint8Array): string {
  return formatPairingComparisonCode(
    new Uint8Array(
      hkdfSync(
        'sha256',
        transcriptHash,
        new Uint8Array(0),
        PAIRING_COMPARISON_CODE_INFO,
        PAIRING_COMPARISON_CODE_BYTES
      )
    )
  )
}
