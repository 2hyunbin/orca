import type { PluginChangeEvent } from '../../shared/plugins/plugin-change-event'

export class PluginServiceChangeEvents {
  private readonly listeners = new Set<(event: PluginChangeEvent) => void>()

  readonly providerChanged = (environmentProviderId: string): void => {
    this.notify({ contentPacksChanged: false, environmentProviderId })
  }

  subscribe(listener: (event: PluginChangeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  notify(event: PluginChangeEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}
