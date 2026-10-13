import {
  PLUGIN_VIEWER_WORKER_LIVENESS_MS,
  PLUGIN_VIEWER_WORKER_PULSE_MS
} from './plugin-viewer-worker-protocol'

export class PluginViewerWorkerLiveness {
  private pulse: string | null = null
  private next: ReturnType<typeof setTimeout> | null = null
  private deadline: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(
    private readonly send: (pulse: string) => void,
    private readonly unavailable: () => void
  ) {
    this.schedule()
  }

  acknowledge(pulse: string): boolean {
    if (this.closed || !this.pulse || pulse !== this.pulse) {
      return false
    }
    if (this.deadline !== null) {
      clearTimeout(this.deadline)
    }
    this.pulse = null
    this.schedule()
    return true
  }

  dispose(): void {
    this.closed = true
    if (this.next !== null) {
      clearTimeout(this.next)
    }
    if (this.deadline !== null) {
      clearTimeout(this.deadline)
    }
    this.pulse = null
  }

  private schedule(): void {
    if (this.closed) {
      return
    }
    this.next = setTimeout(() => {
      try {
        this.pulse = Array.from(crypto.getRandomValues(new Uint32Array(4)), (word) =>
          word.toString(16).padStart(8, '0')
        ).join('')
        this.deadline = setTimeout(() => {
          this.dispose()
          this.unavailable()
        }, PLUGIN_VIEWER_WORKER_LIVENESS_MS)
        this.send(this.pulse)
      } catch {
        this.dispose()
        this.unavailable()
      }
    }, PLUGIN_VIEWER_WORKER_PULSE_MS)
  }
}
