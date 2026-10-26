import type { PostHog } from 'posthog-node'
import type { ConsentState } from './consent'
import { MAX_QUEUED_CAPTURES } from './capture-queue-limit'

type Capture = Parameters<PostHog['capture']>[0]
type TransportOptions = { writeKey: string; consent: ConsentState }
const SHUTDOWN_TIMEOUT_MS = 2_000

export class DeferredTelemetryTransport {
  client: PostHog | null = null
  private generation = 0
  private loading: Promise<void> | null = null
  private closing: Promise<void> | null = null
  private shutdownDeadline: number | null = null
  private stopped = false
  private readonly pending: Capture[] = []
  private readonly optOutStarts = new Set<symbol>()

  constructor(
    private readonly readOptions: () => TransportOptions | null,
    private readonly onDiscard: (captures: readonly Capture[]) => void
  ) {}

  get accepting(): boolean {
    return !this.stopped && (this.client !== null || this.pending.length < MAX_QUEUED_CAPTURES)
  }

  reset(): void {
    this.generation += 1
    this.loading = null
    this.closing = null
    this.shutdownDeadline = null
    this.client = null
    this.stopped = false
    this.optOutStarts.clear()
    this.discardPending()
  }

  discardPending(): void {
    this.onDiscard(this.pending)
    this.pending.length = 0
  }

  capture(capture: Capture): boolean {
    if (!this.accepting || this.client?.optedOut) {
      return false
    }
    if (this.client) {
      this.client.capture(capture)
    } else {
      this.pending.push(capture)
    }
    return true
  }

  start(): Promise<void> {
    return this.stopped ? Promise.resolve() : this.load()
  }

  async startForOptOut(): Promise<PostHog | null> {
    if (this.stopped) {
      return null
    }
    const generation = this.generation
    const request = Symbol()
    this.optOutStarts.add(request)
    try {
      await this.load()
      return this.stopped || generation !== this.generation ? null : this.client
    } finally {
      this.optOutStarts.delete(request)
    }
  }

  private canLoad(options: TransportOptions | null): options is TransportOptions {
    return (
      options !== null &&
      (options.consent.effective !== 'disabled' ||
        (options.consent.reason === 'user_opt_out' && this.optOutStarts.size > 0))
    )
  }

  private load(): Promise<void> {
    if (this.loading) {
      return this.loading
    }
    const options = this.readOptions()
    if (this.client) {
      return Promise.resolve()
    }
    if (!this.canLoad(options)) {
      this.discardPending()
      return Promise.resolve()
    }
    const generation = this.generation
    const start = import('./posthog-transport').then(({ createPostHogClient }) => {
      if (generation !== this.generation) {
        return
      }
      if (this.shutdownDeadline !== null && Date.now() >= this.shutdownDeadline) {
        this.discardPending()
        return
      }
      const current = this.readOptions()
      if (!this.canLoad(current)) {
        this.discardPending()
        return
      }
      // Only an admitted opt-out control may initialize while ordinary telemetry stays disabled.
      this.client = createPostHogClient(
        current.writeKey,
        current.consent.effective === 'disabled' ? { effective: 'pending_banner' } : current.consent
      )
      if (current.consent.effective === 'enabled') {
        const captures = this.pending.splice(0)
        for (const capture of captures) {
          this.client.capture(capture)
        }
      } else {
        this.discardPending()
      }
    })
    this.loading = start.finally(() => {
      if (generation === this.generation) {
        this.loading = null
      }
    })
    return this.loading
  }

  shutdown(): Promise<void> {
    if (this.closing) {
      return this.closing
    }
    this.stopped = true
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS
    this.shutdownDeadline = deadline
    const drainPending =
      this.pending.length > 0 && this.readOptions()?.consent.effective === 'enabled'
    if (!drainPending) {
      this.generation += 1
      this.discardPending()
    }
    const generation = this.generation
    let timeout: ReturnType<typeof setTimeout> | undefined
    const drain = async (): Promise<void> => {
      if (drainPending) {
        await this.load()
      }
      await this.client?.shutdown(Math.max(0, deadline - Date.now()))
    }
    this.closing = Promise.race([
      drain(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)
      })
    ])
      .catch((error) => {
        console.warn('[telemetry] shutdown error (ignored):', error)
      })
      .finally(() => {
        clearTimeout(timeout)
        if (generation === this.generation) {
          // Imports cannot be canceled; retire their generation when the quit budget expires.
          this.generation += 1
          this.discardPending()
        }
      })
    return this.closing
  }
}
