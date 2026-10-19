import { EventEmitter } from 'node:events'

/** Synchronous peer disconnection for IPC contract tests; native lifetime is covered by Electron QA. */
export class TestRendererPort extends EventEmitter {
  peer: TestRendererPort | null = null
  closed = false
  start(): void {}
  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    const peer = this.peer
    this.peer = null
    if (peer) {
      peer.peer = null
      peer.close()
    }
    this.emit('close')
  }
}

export class TestRendererMessageChannel {
  port1 = new TestRendererPort()
  port2 = new TestRendererPort()
  constructor() {
    this.port1.peer = this.port2
    this.port2.peer = this.port1
  }
}
