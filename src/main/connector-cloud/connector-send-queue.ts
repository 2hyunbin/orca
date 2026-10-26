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

/** Sends a batch; null when the cloud accepted it. */
export type ConnectorBatchSender<T> = (batch: T[]) => Promise<ConnectorFailure | null>

/**
 * Items sent in order, one request at a time, through whichever sender is attached.
 * A refused batch stays queued and is retried after a backoff; pushes during that wait only queue.
 */
export class ConnectorSendQueue<T> {
  private items: T[]
  private sender: ConnectorBatchSender<T> | null = null
  private sending = false
  private failures = 0
  private retry: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly options: {
      maxBatch: number
      /** Restored items, sent once a sender is attached. */
      initial?: T[]
      /** Applied to every new item list, so the queue itself never exceeds its bounds. */
      bound?: (items: T[]) => T[]
      /** Called after every change, e.g. to persist what must survive a restart. */
      onChange?: (items: readonly T[]) => void
      onAccepted?: (batch: readonly T[]) => void
      random?: () => number
    }
  ) {
    this.items = options.initial ?? []
  }

  attach(sender: ConnectorBatchSender<T>): void {
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

  /** Keeps only the queued items that `keep` accepts. */
  retain(keep: (item: T) => boolean): void {
    this.replace(this.items.filter(keep))
  }

  private async flush(): Promise<void> {
    const sender = this.sender
    if (this.sending || !sender) {
      return
    }
    this.sending = true
    try {
      while (this.items.length > 0 && this.sender === sender) {
        const batch = this.items.slice(0, this.options.maxBatch)
        const failure = await sender(batch)
        if (failure) {
          this.scheduleRetry(sender, failure)
          return
        }
        this.failures = 0
        // Items retained away during the request are already gone; drop only what was sent.
        this.replace(this.items.filter((item) => !batch.includes(item)))
        this.options.onAccepted?.(batch)
      }
    } finally {
      this.sending = false
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
    this.items = this.options.bound ? this.options.bound(items) : items
    this.options.onChange?.(this.items)
  }
}
