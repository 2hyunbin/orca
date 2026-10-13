import { randomUUID } from 'node:crypto'
import type { PluginEnvironmentProviderSender } from './plugin-environment-providers'

type Owner = { key: string; release(): void }
export class PluginEnvironmentProviderWindowOwners {
  private readonly owners = new Map<number, Owner>()
  constructor(private readonly revoke: (key: string) => void) {}

  ownerKey(sender: PluginEnvironmentProviderSender): string {
    if (sender.isDestroyed()) {
      throw new Error('The app window is no longer available')
    }
    const existing = this.owners.get(sender.id)
    if (existing) {
      return existing.key
    }
    const key = randomUUID()
    const gone = (): void => {
      if (this.owners.get(sender.id)?.key !== key) {
        return
      }
      this.owners.get(sender.id)?.release()
      this.owners.delete(sender.id)
      this.revoke(key)
    }
    const navigate = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
      if (details.isMainFrame && !details.isSameDocument) {
        gone()
      }
    }
    const release = (): void => {
      sender.removeListener('destroyed', gone)
      sender.removeListener('render-process-gone', gone)
      sender.removeListener('did-start-navigation', navigate)
    }
    sender.once('destroyed', gone)
    sender.once('render-process-gone', gone)
    sender.on('did-start-navigation', navigate)
    this.owners.set(sender.id, { key, release })
    return key
  }
}
