import { withEvidenceBudget } from '../../../shared/process-table-snapshot-reader'
import type { TerminalInterfaceBinding } from '../../../shared/terminal-interface-observation'
import type { TerminalProcessInspection } from '../../../shared/terminal-process-inspection'
import type { Lease } from './terminal-interface-contracts'

type InspectionSuccessor = {
  promise: Promise<TerminalProcessInspection | null>
  run: () => Promise<TerminalProcessInspection | null>
  resolve: (result: TerminalProcessInspection | null) => void
}
type InspectionEntry = {
  running: Promise<TerminalProcessInspection | null>
  next?: InspectionSuccessor
}

export class TerminalInterfaceProbe {
  private readonly inspections = new Map<string, InspectionEntry>()
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
    const run = (): Promise<TerminalProcessInspection | null> =>
      lease.controller.signal.aborted ? Promise.resolve(null) : lease.driver.inspect(binding)
    const existing = this.inspections.get(key)
    if (existing) {
      if (!existing.next) {
        existing.next = {
          ...Promise.withResolvers<TerminalProcessInspection | null>(),
          run
        }
      }
      existing.next.run = run
      return existing.next.promise
    }
    const entry: InspectionEntry = {
      running: Promise.resolve()
        .then(run)
        .catch(() => null)
    }
    this.inspections.set(key, entry)
    const settle = (): void => {
      const next = entry.next
      entry.next = undefined
      if (!next) {
        if (this.inspections.get(key) === entry) {
          this.inspections.delete(key)
        }
        return
      }
      entry.running = Promise.resolve()
        .then(next.run)
        .catch(() => null)
      void entry.running.then(next.resolve).then(settle)
    }
    void entry.running.then(settle)
    return entry.running
  }
}
