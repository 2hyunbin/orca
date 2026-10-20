import { webContents, type WebContents } from 'electron'

/** Holds the real engine delivery after original contents creation, not reconstructed options. */
export class BrowserPopupHeldDeliveryFixture {
  private held: { contents: WebContents; release: () => void } | null = null
  private restore: (() => void) | null = null

  constructor(
    private readonly guest: WebContents,
    private readonly record: (
      event: string,
      contents: WebContents,
      extra?: Record<string, unknown>
    ) => void
  ) {}

  holdNext(): void {
    const emit = this.guest.emit
    this.restore = () => {
      this.guest.emit = emit
      this.restore = null
    }
    this.guest.emit = (event, ...args: unknown[]) => {
      if (event !== '-add-new-contents' || this.held) {
        return emit.call(this.guest, event, ...args)
      }
      const candidate = args[1]
      if (
        typeof candidate !== 'object' ||
        candidate === null ||
        !('id' in candidate) ||
        typeof candidate.id !== 'number'
      ) {
        throw new Error('Missing original engine child')
      }
      const contents = webContents.fromId(candidate.id)
      if (!contents || contents !== candidate || contents.opener?.top !== this.guest.mainFrame) {
        throw new Error('Original engine child has no matching public identity')
      }
      this.held = { contents, release: () => emit.call(this.guest, event, ...args) }
      this.record('delivery-held', contents)
      return false
    }
  }

  beforeNextRequest(): void {
    if (!this.held) {
      return
    }
    this.record('held-original-before-next-request', this.held.contents)
    setTimeout(() => this.release(), 100)
  }

  cancel(): void {
    if (this.held) {
      this.record('held-original-canceled', this.held.contents)
      this.held.contents.close()
    }
    setTimeout(() => this.release(), 100)
  }

  releaseLive(): void {
    this.release(true)
  }

  private release(allowLive = false): void {
    const held = this.held
    if (!held) {
      return
    }
    this.restore?.()
    this.held = null
    if (!held.contents.isDestroyed()) {
      if (!allowLive) {
        throw new Error('The rejected/canceled original child remained live at delivery')
      }
      // This control has one admission, so its original hidden construction options are intact.
      this.record('held-original-released', held.contents)
      held.release()
      return
    }
    this.record('held-delivery-discarded', this.guest, { childContentsId: held.contents.id })
  }
}
