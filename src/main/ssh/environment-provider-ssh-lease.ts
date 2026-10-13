import type { EnvironmentProviderSshLease } from './environment-provider-ssh-admission'

/** One transport attempt keeps its revocation listener through the live session. */
export class EnvironmentProviderSshTransportLease {
  private lease: EnvironmentProviderSshLease | null = null
  private release: (() => void) | null = null

  replace(lease: EnvironmentProviderSshLease | null, revoke: () => void): void {
    this.clear()
    this.lease = lease
    if (!lease) {
      return
    }
    const onAbort = (): void => {
      if (this.lease === lease) {
        revoke()
      }
    }
    lease.signal.addEventListener('abort', onAbort, { once: true })
    this.release = () => lease.signal.removeEventListener('abort', onAbort)
    if (!this.isCurrent()) {
      onAbort()
    }
  }

  isCurrent(): boolean {
    return !this.lease || (!this.lease.signal.aborted && this.lease.isCurrent())
  }

  clear(): void {
    this.release?.()
    this.release = null
    this.lease = null
  }
}
