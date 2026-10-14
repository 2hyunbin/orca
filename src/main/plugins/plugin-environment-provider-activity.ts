type ProviderActivity = {
  providerId: string
  mutation: boolean
  resourceId?: string
  allResources?: boolean
}

export class PluginEnvironmentProviderActivity {
  private readonly providers = new Map<object, ProviderActivity>()
  private readonly pending = new Set<Promise<void>>()
  private closing = false

  enter(providerId: string) {
    this.requireOpen()
    if (
      this.providers.size >= 8 ||
      [...this.providers.values()].some((entry) => entry.providerId === providerId)
    ) {
      throw new Error('An environment operation is already running on this host or provider')
    }
    const slot = {}
    this.providers.set(slot, { providerId, mutation: false })
    return { slot, finish: this.begin() }
  }

  update(slot: object, entry: ProviderActivity): void {
    if (!this.providers.has(slot)) {
      throw new Error('The environment operation is no longer owned by this host')
    }
    this.providers.set(slot, entry)
  }
  entries() {
    return this.providers.entries()
  }
  values() {
    return this.providers.values()
  }
  release(slot: object): void {
    this.providers.delete(slot)
  }

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
  private requireOpen(): void {
    if (this.closing) {
      throw new Error('The environment provider host is shutting down')
    }
  }
  private begin(): () => void {
    const done = Promise.withResolvers<void>()
    this.pending.add(done.promise)
    return () => {
      this.pending.delete(done.promise)
      done.resolve()
    }
  }
}
