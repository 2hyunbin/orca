import type { JournalPendingRow } from './journal-structural-fold-step'
import type { JournalRestProjection } from './journal-rest-projection'
import { deserialize, serialize } from 'node:v8'

export const JOURNAL_STRUCTURAL_SCRATCH_FORMAT = 7

/** Disposable keys are code-unit identities, independent of V8's internal string representation. */
export function encodeStructuralScratchKey(key: unknown): Buffer {
  if (typeof key === 'string') {
    const bytes = Buffer.allocUnsafe(1 + key.length * 2)
    bytes[0] = 0
    bytes.write(key, 1, key.length * 2, 'utf16le')
    return bytes
  }
  if (typeof key === 'number' && Number.isFinite(key)) {
    const bytes = Buffer.allocUnsafe(9)
    bytes[0] = 1
    bytes.writeDoubleLE(key, 1)
    return bytes
  }
  return Buffer.concat([Buffer.from([2]), serialize(key)])
}

export function decodeStructuralScratchKey(encoded: Uint8Array): unknown {
  const bytes = Buffer.from(encoded)
  if (bytes[0] === 0 && bytes.length % 2 === 1) {
    return bytes.toString('utf16le', 1)
  }
  if (bytes[0] === 1 && bytes.length === 9) {
    return bytes.readDoubleLE(1)
  }
  if (bytes[0] === 2) {
    return deserialize(bytes.subarray(1))
  }
  throw new Error('invalid derived journal key')
}

/** Only immutable namespace bytes survive a chunk; never a map value or parsed payload. */
export class JournalScratchNamespaces {
  private readonly spaces = new Map<string, Buffer>()
  private bytes = 0

  bind(name: string): Buffer {
    const existing = this.spaces.get(name)
    if (existing) {
      return existing
    }
    const encoded = Buffer.allocUnsafeSlow(name.length * 2)
    encoded.write(name, 'utf16le')
    if (encoded.byteLength > 1024) {
      return encoded
    }
    const retained = encoded.byteLength * 2
    while (this.spaces.size >= 128 || this.bytes + retained > 64 * 1024) {
      const first = this.spaces.keys().next().value
      if (first === undefined) {
        break
      }
      this.bytes -= this.spaces.get(first)!.byteLength * 2
      this.spaces.delete(first)
    }
    // Decode an owned copy so a short sliced name cannot retain its original large backing string.
    this.spaces.set(encoded.toString('utf16le'), encoded)
    this.bytes += retained
    return encoded
  }

  clear(): void {
    this.spaces.clear()
    this.bytes = 0
  }
}

export type JournalStructuralCheckpoint = {
  sessionId: string
  guard: string
  cursor: number
  pending?: JournalPendingRow
  selection?: { format: typeof JOURNAL_STRUCTURAL_SCRATCH_FORMAT }
  agent?: string
  rest: ReturnType<JournalRestProjection['checkpoint']>
  scope: string | null
  latestAcceptedTurnSequence: number
  queueRevision?: number
}
