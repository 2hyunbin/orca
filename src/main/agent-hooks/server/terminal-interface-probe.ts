import { withEvidenceBudget } from '../../../shared/process-table-snapshot-reader'
import type { TerminalInterfaceBinding } from '../../../shared/terminal-interface-observation'
import type { TerminalProcessInspection } from '../../../shared/terminal-process-inspection'
import type { Lease } from './terminal-interface-contracts'

export class TerminalInterfaceProbe {
  private readonly inspections = new Map<string, Promise<TerminalProcessInspection | null>>()
  /** Both provider waits and presence probes have a deadline; disposal also releases the lease. */
  async bounded<T>(lease: Lease, pending: Promise<T>): Promise<T> {
    let abort: () => void = () => {}
    try {
      return await withEvidenceBudget(
        Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            abort = () => reject(new Error('terminal interface driver disposed'))
            lease.controller.signal.addEventListener('abort', abort, { once: true })
            if (lease.controller.signal.aborted) {
              abort()
            }
          })
        ])
      )
    } finally {
      lease.controller.signal.removeEventListener('abort', abort)
    }
  }

  /** A timed-out waiter never starts duplicate provider work while its bounded capture settles. */
  inspect(
    lease: Lease,
    binding: TerminalInterfaceBinding
  ): Promise<TerminalProcessInspection | null> {
    const key = JSON.stringify([binding.ptyId, binding.incarnationId])
    const existing = this.inspections.get(key)
    if (existing) {
      return existing
    }
    const pending = lease.driver.inspect(binding)
    const result = withEvidenceBudget(pending).catch(() => null)
    this.inspections.set(key, result)
    const release = (): void => {
      if (this.inspections.get(key) === result) {
        this.inspections.delete(key)
      }
    }
    void pending.then(release, release)
    return result
  }
}
