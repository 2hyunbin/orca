/** Items sent in order, one request at a time; a refused batch stays queued until the next flush. */
export class ConnectorSendQueue<T> {
  private items: T[] = []
  private sending = false

  constructor(
    private readonly send: (batch: T[]) => Promise<boolean>,
    private readonly options: {
      maxBatch: number
      /** Restored items, sent on the next flush. */
      initial?: T[]
      /** Called after every change, e.g. to persist what must survive a restart. */
      onChange?: (items: readonly T[]) => void
      onAccepted?: (batch: readonly T[]) => void
    }
  ) {
    this.items = options.initial ?? []
  }

  get pending(): readonly T[] {
    return this.items
  }

  push(...items: T[]): void {
    this.replace([...this.items, ...items])
    void this.flush()
  }

  /** Keeps only the queued items that `keep` accepts. */
  retain(keep: (item: T) => boolean): void {
    this.replace(this.items.filter(keep))
  }

  /** Sends until the queue is empty or a batch is refused; a no-op while a send is in flight. */
  async flush(): Promise<void> {
    if (this.sending) {
      return
    }
    this.sending = true
    try {
      while (this.items.length > 0) {
        const batch = this.items.slice(0, this.options.maxBatch)
        if (!(await this.send(batch))) {
          return
        }
        // Items retained away during the request are already gone; drop only what was sent.
        this.replace(this.items.filter((item) => !batch.includes(item)))
        this.options.onAccepted?.(batch)
      }
    } finally {
      this.sending = false
    }
  }

  private replace(items: T[]): void {
    this.items = items
    this.options.onChange?.(items)
  }
}
