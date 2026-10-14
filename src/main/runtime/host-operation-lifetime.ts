export class HostOperationLifetime {
  private readonly pending = new Set<Promise<void>>()
  private closing = false
  constructor(private readonly closedMessage: string) {}

  async track<T>(run: () => Promise<T>): Promise<T> {
    this.requireOpen()
    const finish = this.begin()
    try {
      return await run()
    } finally {
      finish()
    }
  }

  async drain(): Promise<void> {
    this.closing = true
    await Promise.all(this.pending)
  }
  protected requireOpen(): void {
    if (this.closing) {
      throw new Error(this.closedMessage)
    }
  }
  protected begin(): () => void {
    const done = Promise.withResolvers<void>()
    this.pending.add(done.promise)
    return () => {
      this.pending.delete(done.promise)
      done.resolve()
    }
  }
}
