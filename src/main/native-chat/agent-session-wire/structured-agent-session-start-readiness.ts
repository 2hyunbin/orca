export type StructuredAgentSessionStartReadiness = {
  wait: (budgetMs?: number) => Promise<'ready' | 'ended' | 'timeout'>
  reserveOperation?: () => () => void
  waitForOperations?: () => Promise<void>
}

export async function waitForStructuredAgentSessionStart(
  ready: Promise<'ready' | 'ended'>,
  budgetMs?: number
): Promise<'ready' | 'ended' | 'timeout'> {
  if (budgetMs === undefined) {
    return ready
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, budgetMs))
    timer.unref?.()
  })
  try {
    return await Promise.race([ready, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Reservations last only as long as the caller's bounded wait and queued operation. */
export class StructuredAgentSessionOperationOrder {
  private readonly operations = new Map<string, Set<Promise<void>>>()

  reserve(sessionId: string): () => void {
    const operation = Promise.withResolvers<void>()
    const pending = this.operations.get(sessionId) ?? new Set<Promise<void>>()
    pending.add(operation.promise)
    this.operations.set(sessionId, pending)
    return () => {
      operation.resolve()
      pending.delete(operation.promise)
      if (pending.size === 0 && this.operations.get(sessionId) === pending) {
        this.operations.delete(sessionId)
      }
    }
  }

  pending(sessionId: string): Promise<void> | null {
    const pending = this.operations.get(sessionId)
    return pending?.size ? Promise.all(pending).then(() => undefined) : null
  }
}
