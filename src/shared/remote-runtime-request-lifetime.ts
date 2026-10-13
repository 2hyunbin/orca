import type { RuntimeRpcResponse } from './runtime-rpc-envelope'

export type RemoteRuntimeSingleConnectionLifetime = {
  kind: 'single-connection'
  onClosed(): void
  onResponse?(response: RuntimeRpcResponse<unknown>): void
}

export class RemoteRuntimeRequestLifetime {
  private idleCloseTimer: ReturnType<typeof setTimeout> | null = null
  retired = false

  constructor(private readonly singleConnection?: RemoteRuntimeSingleConnectionLifetime) {}

  readonly receive = (response: RuntimeRpcResponse<unknown>): void => {
    this.singleConnection?.onResponse?.(response)
  }

  clearIdleCloseTimer(): void {
    if (this.idleCloseTimer) {
      clearTimeout(this.idleCloseTimer)
      this.idleCloseTimer = null
    }
  }

  scheduleIdleClose(close: () => void, idle = true): void {
    if (this.singleConnection || !idle) {
      return
    }
    this.clearIdleCloseTimer()
    const timer = (this.idleCloseTimer = setTimeout(close, 60_000))
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }
  }

  retire(): boolean {
    if (this.retired) {
      return false
    }
    this.retired = this.singleConnection !== undefined
    this.clearIdleCloseTimer()
    return true
  }

  notifyClosed(): void {
    try {
      this.singleConnection?.onClosed()
    } catch (error) {
      console.warn('[runtime] request connection retirement listener failed:', error)
    }
  }
}
