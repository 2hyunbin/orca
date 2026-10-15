import { startTransition } from 'react'
import { hasInputBeenQuietFor, scheduleAfterInputQuiet } from '@/lib/input-quiet-scheduler'

const AI_VAULT_PUBLICATION_QUIET_MS = 100
const AI_VAULT_PUBLICATION_MAX_WAIT_MS = 1_000

export class AiVaultSessionPublicationGate {
  private generation = 0
  private cancelPending: (() => void) | null = null
  private pending: (() => void) | null = null
  private provisional = false
  private lastProvisionalAt = Number.NEGATIVE_INFINITY

  publish<T>(result: T, apply: (result: T) => void): void {
    if (this.provisional) this.cancel()
    this.pending = () => apply(result)
    this.schedule(false)
  }

  publishProvisional(apply: () => void): void {
    this.pending = apply
    this.provisional = true
    this.schedule(true)
  }

  private schedule(provisional: boolean): void {
    // Continuous row batches replace the value, not the original input-quiet deadline.
    if (this.cancelPending) return
    if (!provisional && hasInputBeenQuietFor(AI_VAULT_PUBLICATION_QUIET_MS)) {
      this.flush()
      return
    }
    const generation = this.generation
    this.cancelPending = scheduleAfterInputQuiet(
      () => {
        if (generation !== this.generation) return
        this.cancelPending = null
        this.flush()
      },
      {
        delayMs: provisional ? Math.max(0, 250 - (performance.now() - this.lastProvisionalAt)) : 0,
        quietMs: AI_VAULT_PUBLICATION_QUIET_MS,
        idleTimeoutMs: AI_VAULT_PUBLICATION_QUIET_MS,
        maxWaitMs: AI_VAULT_PUBLICATION_MAX_WAIT_MS
      }
    )
  }

  cancel(): void {
    this.generation += 1
    this.cancelPending?.()
    this.cancelPending = null
    this.pending = null
    this.provisional = false
    this.lastProvisionalAt = Number.NEGATIVE_INFINITY
  }

  private flush(): void {
    const pending = this.pending
    this.pending = null
    if (this.provisional) this.lastProvisionalAt = performance.now()
    this.provisional = false
    if (pending) startTransition(pending)
  }
}
