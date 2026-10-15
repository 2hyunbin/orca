import { structuralValuesEqual } from '../../shared/structural-value-equality'
import type { AiVaultRowDelta, AiVaultRowObserver } from '../../shared/ai-vault-scan-rows'
import type { AiVaultSession } from '../../shared/ai-vault-types'

const ROW_BATCH_BYTES = 128 * 1024
const ROW_BATCH_INTERVAL_MS = 250

/** One in-flight frame; newer observations replace pending work, never append to a queue. */
export class SessionRowPublisher {
  private read: (() => readonly AiVaultSession[]) | null = null
  private readonly sent = new Map<string, AiVaultSession>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private flight: Promise<void> | null = null
  private retired = false
  private started = false

  constructor(private readonly send: (delta: AiVaultRowDelta) => Promise<void>) {}

  readonly observe: AiVaultRowObserver = (read) => {
    if (this.retired) return
    this.read = read
    if (!this.started) {
      this.started = true
      return this.flush()
    }
    if (!this.timer && !this.flight) {
      this.timer = setTimeout(() => {
        this.timer = null
        void this.flush()
      }, ROW_BATCH_INTERVAL_MS)
    }
    return this.flight ?? undefined
  }

  async finish(): Promise<void> {
    this.retired = true
    this.read = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.flight
  }

  private flush(): Promise<void> {
    if (this.flight) return this.flight
    const read = this.read
    this.read = null
    if (!read || this.retired) return Promise.resolve()
    this.flight = Promise.resolve().then(() => this.deliver(read())).catch(() => {
      // A failed preview channel must not fail the authoritative scan.
      this.retired = true
    }).finally(() => {
      this.flight = null
      if (this.read && !this.retired && !this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null
          void this.flush()
        }, ROW_BATCH_INTERVAL_MS)
      }
    })
    return this.flight
  }

  private async deliver(rows: readonly AiVaultSession[]): Promise<void> {
    const current = new Map(rows.map((row) => [row.id, row]))
    let delta: AiVaultRowDelta = { upserts: [], removed: [] }
    let bytes = 0
    const flush = async (): Promise<void> => {
      if (!this.retired && (delta.upserts.length || delta.removed.length)) {
        await this.send(delta)
      }
      delta = { upserts: [], removed: [] }
      bytes = 0
    }
    for (const id of this.sent.keys()) {
      if (this.retired) return
      if (current.has(id)) continue
      const size = Buffer.byteLength(JSON.stringify(id)) + 1
      if (bytes + size > ROW_BATCH_BYTES) await flush()
      delta.removed.push(id)
      bytes += size
      this.sent.delete(id)
    }
    for (const row of current.values()) {
      if (this.retired) return
      if (structuralValuesEqual(this.sent.get(row.id), row)) continue
      const size = Buffer.byteLength(JSON.stringify(row)) + 1
      // Oversized previews still arrive in the ordinary final response.
      if (size > ROW_BATCH_BYTES) continue
      if (bytes + size > ROW_BATCH_BYTES) await flush()
      delta.upserts.push(row)
      bytes += size
      this.sent.set(row.id, row)
    }
    await flush()
  }
}
