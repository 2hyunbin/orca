import type { ConnectorFailure } from './connector-cloud-request'

const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 30_000

/** Random doubling from 1 s to 30 s; a cloud's Retry-After wins when longer. */
export function connectorRetryDelayMs(
  failures: number,
  failure: ConnectorFailure,
  random: () => number
): number {
  const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** failures)
  return Math.max(failure.retryAfterMs ?? 0, ceiling * (0.5 + random() / 2))
}

/** Sends a batch with its number; null when the cloud accepted it. */
export type ConnectorBatchSender<T> = (batch: T[], seq: number) => Promise<ConnectorFailure | null>

/**
 * Items sent strictly in order, one request at a time, through whichever sender is attached.
 * Each batch is numbered and frozen when first sent; a refusal retries that same batch, with the same
 * number, after a backoff, and nothing later goes out before it. Pushes during the wait only queue.
 */
export class ConnectorSendQueue<T> {
  private items: T[]
  private head: { seq: number; batch: T[] } | null = null
  private nextSeq = 0
  private sender: ConnectorBatchSender<T> | null = null
  private sending = false
  private failures = 0
  private retry: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly options: {
      maxBatch: number
      /** Restored items, sent once a sender is attached. */
      initial?: T[]
      /** Trims the unsent items, given the frozen batch, so everything owed stays within bounds. */
      bound?: (items: T[], frozen: readonly T[]) => T[]
      /** Called after every change with everything still owed, e.g. to persist it. */
      onChange?: (items: readonly T[]) => void
      onAccepted?: (batch: readonly T[]) => void
      random?: () => number
    }
  ) {
    this.items = options.initial ?? []
  }

  /** Re-attaching the same sender keeps its pending retry. */
  attach(sender: ConnectorBatchSender<T>): void {
    if (this.sender === sender) {
      return
    }
    this.sender = sender
    this.failures = 0
    this.cancelRetry()
    void this.flush()
  }

  /** Only the sender attached now; a retired one cannot detach its replacement. */
  detach(sender: ConnectorBatchSender<T>): void {
    if (this.sender === sender) {
      this.sender = null
      this.cancelRetry()
    }
  }

  push(...items: T[]): void {
    this.replace([...this.items, ...items])
    if (!this.retry) {
      void this.flush()
    }
  }

  /**
   * Starts numbering again from 0 with `first` at the front, keeping what `keep` accepts of everything
   * still owed, the frozen batch included. A new cloud session sees none of the old numbers.
   */
  restart(first: T[], keep: (item: T) => boolean): void {
    const owed = [...(this.head?.batch ?? []), ...this.items].filter(keep)
    this.head = null
    this.nextSeq = 0
    this.failures = 0
    this.cancelRetry()
    this.replace([...first, ...owed])
    void this.flush()
  }

  private async flush(): Promise<void> {
    const sender = this.sender
    if (this.sending || !sender) {
      return
    }
    this.sending = true
    try {
      while (this.sender === sender && (this.head || this.items.length > 0)) {
        const head = (this.head ??= {
          seq: this.nextSeq++,
          batch: this.items.splice(0, this.options.maxBatch)
        })
        const failure = await sender(head.batch, head.seq)
        // A restart took the batch back meanwhile; whatever it holds now goes next.
        if (this.head !== head) {
          continue
        }
        if (failure) {
          this.scheduleRetry(sender, failure)
          return
        }
        this.failures = 0
        this.head = null
        this.notify()
        this.options.onAccepted?.(head.batch)
      }
    } finally {
      this.sending = false
      // A sender attached while a retired one was mid-request takes over here.
      if (this.sender && this.sender !== sender && !this.retry) {
        void this.flush()
      }
    }
  }

  private scheduleRetry(sender: ConnectorBatchSender<T>, failure: ConnectorFailure): void {
    if (this.sender !== sender) {
      return
    }
    const delayMs = connectorRetryDelayMs(
      this.failures++,
      failure,
      this.options.random ?? Math.random
    )
    this.retry = setTimeout(() => {
      this.retry = null
      void this.flush()
    }, delayMs)
    this.retry.unref?.()
  }

  private cancelRetry(): void {
    if (this.retry) {
      clearTimeout(this.retry)
      this.retry = null
    }
  }

  private replace(items: T[]): void {
    this.items = this.options.bound ? this.options.bound(items, this.head?.batch ?? []) : items
    this.notify()
  }

  private notify(): void {
    this.options.onChange?.([...(this.head?.batch ?? []), ...this.items])
  }
}
