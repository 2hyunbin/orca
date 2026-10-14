import { HostOperationLifetime } from '../runtime/host-operation-lifetime'

type ProviderActivity = {
  providerId: string
  mutation: boolean
  resourceId?: string
  allResources?: boolean
}
type ProviderActivitySlot = symbol

export class PluginEnvironmentProviderActivity extends HostOperationLifetime {
  private readonly providers = new Map<ProviderActivitySlot, ProviderActivity>()
  constructor() {
    super('The environment provider host is shutting down')
  }

  enter(providerId: string) {
    this.requireOpen()
    if (
      this.providers.size >= 8 ||
      [...this.providers.values()].some((entry) => entry.providerId === providerId)
    ) {
      throw new Error('An environment operation is already running on this host or provider')
    }
    const slot = Symbol(providerId)
    this.providers.set(slot, { providerId, mutation: false })
    return { slot, finish: this.begin() }
  }

  update(slot: ProviderActivitySlot, entry: ProviderActivity): void {
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
  release(slot: ProviderActivitySlot): void {
    this.providers.delete(slot)
  }
}
