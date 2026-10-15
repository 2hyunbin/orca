/** Open desktop work and connection-scoped work share the host's reconnect policy. */
export class WslHostWorkDemand {
  visible = new Set<string>()
  private readonly remote = new Map<string, Set<symbol>>()

  has(environmentId: string): boolean {
    return this.visible.has(environmentId) || (this.remote.get(environmentId)?.size ?? 0) > 0
  }

  acquire(environmentId: string): () => void {
    const leases = this.remote.get(environmentId) ?? new Set<symbol>()
    const lease = Symbol()
    leases.add(lease)
    this.remote.set(environmentId, leases)
    return () => {
      leases.delete(lease)
      if (leases.size === 0 && this.remote.get(environmentId) === leases) {
        this.remote.delete(environmentId)
      }
    }
  }

  delete(environmentId: string): void {
    this.visible.delete(environmentId)
    this.remote.delete(environmentId)
  }
}
