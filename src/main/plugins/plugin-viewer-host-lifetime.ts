import type { WebContents } from 'electron'

export class PluginViewerHostLifetime {
  private current = true
  constructor(
    private readonly host: WebContents,
    private readonly onRevoked: () => void
  ) {
    host.once('destroyed', this.revoke)
    host.on('did-start-navigation', this.navigate)
  }
  isCurrent(): boolean {
    return this.current && !this.host.isDestroyed()
  }
  dispose(): void {
    this.current = false
    this.host.removeListener('destroyed', this.revoke)
    this.host.removeListener('did-start-navigation', this.navigate)
  }
  private readonly navigate = (details: {
    isMainFrame: boolean
    isSameDocument: boolean
  }): void => {
    if (details.isMainFrame && !details.isSameDocument) {
      this.revoke()
    }
  }
  private readonly revoke = (): void => {
    if (this.current) {
      this.current = false
      this.onRevoked()
    }
  }
}
