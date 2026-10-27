import type { PostHog } from 'posthog-node'
import type { ConsentState } from './consent'
import { MAX_QUEUED_CAPTURES } from './capture-queue-limit'

type Capture = Parameters<PostHog['capture']>[0]
type OptOutCapture = Capture & { event: 'telemetry_opted_out'; uuid: string }
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
  private readonly optOutCaptures = new Set<Promise<void>>()

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
    this.optOutCaptures.clear()
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

  captureOptOut(capture: OptOutCapture, canCapture: () => boolean): Promise<void> {
    if (this.stopped) {
      return Promise.resolve()
    }
    const generation = this.generation
    const operation = Promise.resolve().then(async () => {
      let client = this.client
      try {
        if (!this.withinShutdownBudget(generation) || !canCapture()) {
          return
        }
        await this.load()
        if (generation !== this.generation) {
          return
        }
        client = this.client
        if (!client) {
          return
        }
        const { waitForCaptureEnqueue } = await import('./posthog-transport')
        if (!this.withinShutdownBudget(generation) || !canCapture()) {
          return
        }
        const remaining =
          this.shutdownDeadline === null ? undefined : this.shutdownDeadline - Date.now()
        const enqueued = waitForCaptureEnqueue(client, capture.event, capture.uuid, remaining)
        client.capture(capture)
        if (!(await enqueued)) {
          console.warn('[telemetry] telemetry_opted_out did not enqueue before SDK opt-out')
        }
      } catch (err) {
        console.warn('[telemetry] telemetry_opted_out capture failed before SDK opt-out:', err)
      } finally {
        await client?.optOut()
      }
    })
    // Register before yielding so quit joins an already authorized consent action.
    this.optOutCaptures.add(operation)
    return operation.finally(() => {
      this.optOutCaptures.delete(operation)
    })
  }

  private withinShutdownBudget(generation: number): boolean {
    return (
      generation === this.generation &&
      (this.shutdownDeadline === null || Date.now() < this.shutdownDeadline)
    )
  }

  private canLoad(options: TransportOptions | null): options is TransportOptions {
    return (
      options !== null &&
      (options.consent.effective !== 'disabled' ||
        (options.consent.reason === 'user_opt_out' && this.optOutCaptures.size > 0))
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
    const optOutCaptures = [...this.optOutCaptures]
    if (!drainPending) {
      this.discardPending()
      if (optOutCaptures.length === 0) {
        this.generation += 1
      }
    }
    const generation = this.generation
    let timeout: ReturnType<typeof setTimeout> | undefined
    let sdkShutdown: Promise<void> | null = null
    const shutdownClient = (): Promise<void> => {
      if (!sdkShutdown && this.client) {
        sdkShutdown = this.client.shutdown(Math.max(0, deadline - Date.now()))
      }
      return sdkShutdown ?? Promise.resolve()
    }
    const drain = async (): Promise<void> => {
      if (drainPending) {
        await this.load()
      }
      await Promise.allSettled(optOutCaptures)
      if (generation !== this.generation) {
        return
      }
      await shutdownClient()
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
          // Even a spent budget must retire a constructed SDK's flush timer.
          if (!sdkShutdown) {
            void shutdownClient().catch((error) => {
              console.warn('[telemetry] shutdown error (ignored):', error)
            })
          }
          // Imports cannot be canceled; retire their generation when the quit budget expires.
          this.generation += 1
          this.discardPending()
          this.optOutCaptures.clear()
        }
      })
    return this.closing
  }
}
