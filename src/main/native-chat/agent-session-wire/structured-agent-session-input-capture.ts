import type {
  StructuredAgentSessionEventTarget,
  StructuredAgentSessionInputPermit,
  StructuredAgentSessionSinkAdmission
} from './structured-agent-session-event-sink'
import type { StructuredAgentSessionSinkOperation } from './structured-agent-session-event-sink-queue'

type Operation = Omit<StructuredAgentSessionSinkOperation, 'sequence'>
type Capture = {
  operation: Operation
  children: Operation[]
  outcomes: Promise<unknown>[]
  target: StructuredAgentSessionEventTarget | null
  started: boolean
}

/** One source stack owns one queue operation; child journal calls keep their original positions. */
export class StructuredAgentSessionInputCapture {
  private permit: StructuredAgentSessionInputPermit | null = null
  private capture: Capture | null = null
  private sealed = false

  constructor(
    private readonly deps: {
      open: () => boolean
      canReserve: () => boolean
      submit: (operation: Operation) => StructuredAgentSessionSinkAdmission
      charge: (bytes: number) => void
      run: (operation: Operation, target: StructuredAgentSessionEventTarget) => Promise<unknown>
      pressure: () => void
    }
  ) {}

  get reserved(): boolean {
    return this.permit !== null
  }

  cancel = (): void => {
    this.permit?.cancel()
  }

  reserve = (): StructuredAgentSessionInputPermit | null => {
    if (this.sealed || !this.deps.open() || !this.deps.canReserve()) {
      return null
    }
    if (this.permit) {
      return this.permit
    }
    let available = true
    const permit: StructuredAgentSessionInputPermit = {
      cancel: () => {
        available = false
        if (this.permit === permit) {
          this.permit = null
        }
      },
      run: (receive) => {
        if (!available || !this.deps.open()) {
          throw new Error('structured agent-session input permit is no longer available')
        }
        permit.cancel()
        this.receive(receive, false)
      }
    }
    this.permit = permit
    return permit
  }

  seal = (receive: () => void): void => {
    this.sealed = true
    this.cancel()
    this.receive(receive, true)
  }

  append(operation: Operation): boolean {
    const capture = this.capture
    if (!capture) {
      return false
    }
    if (!capture.started) {
      const admission = this.deps.submit(capture.operation)
      if (!admission.accepted) {
        throw new Error(`structured agent-session capture refused: ${admission.reason}`)
      }
      capture.started = true
    }
    capture.operation.bytes += operation.bytes
    this.deps.charge(operation.bytes)
    capture.children.push(operation)
    if (capture.target) {
      capture.outcomes.push(this.deps.run(operation, capture.target))
    }
    return true
  }

  private receive(receive: () => void, finalTail: boolean): void {
    if (this.capture) {
      receive()
      return
    }
    const done = Promise.withResolvers<void>()
    const capture: Capture = {
      children: [],
      outcomes: [],
      target: null,
      started: false,
      operation: {
        bytes: 0,
        ...(finalTail ? { finalTail: true } : {}),
        run: (bound) => {
          capture.target = bound
          for (const child of capture.children) {
            capture.outcomes.push(this.deps.run(child, bound))
          }
          return done.promise.then(() => Promise.all(capture.outcomes))
        }
      }
    }
    this.capture = capture
    try {
      receive()
    } finally {
      this.capture = null
      done.resolve()
      this.deps.pressure()
    }
  }
}
