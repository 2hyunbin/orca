import type { Delivery } from './external-conversation-types'

type Receipt = { payload: string; delivery: Promise<Delivery> }

const SETTLED_RECEIPT_LIMIT = 1000

/**
 * A caller's delivery ids, scoped by conversation: the same id and payload share one delivery, and
 * the same id with another payload is refused. Settled receipts are bounded; an operation still
 * running is never evicted, so a retry during it can never start a second one.
 */
export class DeliveryReceipts {
  private readonly active = new Map<string, Receipt>()
  private readonly settled = new Map<string, Receipt>()

  constructor(private readonly settledLimit = SETTLED_RECEIPT_LIMIT) {}

  /** Null when the id was already used for a different payload. */
  run(id: string, payload: string, execute: () => Promise<Delivery>): Promise<Delivery> | null {
    const existing = this.active.get(id) ?? this.settled.get(id)
    if (existing) {
      return existing.payload === payload ? existing.delivery : null
    }
    const delivery = execute()
    const receipt: Receipt = { payload, delivery }
    this.active.set(id, receipt)
    const settle = (): void => {
      this.active.delete(id)
      this.settled.set(id, receipt)
      for (const oldest of this.settled.keys()) {
        if (this.settled.size <= this.settledLimit) {
          break
        }
        this.settled.delete(oldest)
      }
    }
    delivery.then(settle, settle)
    return delivery
  }
}
