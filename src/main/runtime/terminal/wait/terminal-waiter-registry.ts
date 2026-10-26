import type { RuntimeTerminalWait } from '../../../../shared/runtime-terminal-contracts'
import type { TerminalWaiter } from '../../runtime-terminal-contracts'

export class RuntimeTerminalWaiterRegistry {
  private readonly byHandle = new Map<string, Set<TerminalWaiter>>()

  get(handle: string): ReadonlySet<TerminalWaiter> | undefined {
    return this.byHandle.get(handle)
  }

  /** Every wait on one terminal, whichever handle it was asked through. */
  forPty(ptyId: string): TerminalWaiter[] {
    return [...this.byHandle.values()].flatMap((waiters) =>
      [...waiters].filter((waiter) => waiter.ptyId === ptyId)
    )
  }

  add(waiter: TerminalWaiter): void {
    const waiters = this.byHandle.get(waiter.handle) ?? new Set<TerminalWaiter>()
    waiters.add(waiter)
    this.byHandle.set(waiter.handle, waiters)
  }

  resolve(waiter: TerminalWaiter, result: RuntimeTerminalWait): void {
    this.remove(waiter)
    waiter.resolve(result)
  }

  bindAbort(waiter: TerminalWaiter, signal: AbortSignal | undefined): boolean {
    if (!signal) {
      return true
    }
    if (signal.aborted) {
      return false
    }
    const onAbort = (): void => {
      this.remove(waiter)
      waiter.reject(new Error('request_aborted'))
    }
    waiter.abortCleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    return true
  }

  reject(waiter: TerminalWaiter, code: string): void {
    this.remove(waiter)
    waiter.reject(new Error(code))
  }

  rejectPty(ptyId: string, code: string): void {
    for (const waiter of this.forPty(ptyId)) {
      this.reject(waiter, code)
    }
  }

  rejectAll(code: string): void {
    for (const waiters of Array.from(this.byHandle.values())) {
      for (const waiter of Array.from(waiters)) {
        this.reject(waiter, code)
      }
    }
  }

  remove(waiter: TerminalWaiter): void {
    if (waiter.timeout) {
      clearTimeout(waiter.timeout)
    }
    if (waiter.cancelIdlePoll) {
      waiter.cancelIdlePoll()
    }
    if (waiter.abortCleanup) {
      waiter.abortCleanup()
      waiter.abortCleanup = null
    }
    const waiters = this.byHandle.get(waiter.handle)
    if (!waiters) {
      return
    }
    waiters.delete(waiter)
    if (waiters.size === 0) {
      this.byHandle.delete(waiter.handle)
    }
  }
}
