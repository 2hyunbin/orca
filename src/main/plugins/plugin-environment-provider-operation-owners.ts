export type PluginEnvironmentProviderRequestOwner = {
  key: string
  signal: AbortSignal
  reviewKey?: string
}

type ActiveOperation = { key: string; controller: AbortController }

export class PluginEnvironmentProviderOperationOwners {
  private readonly active = new Map<string, ActiveOperation>()

  async run<T>(
    owner: PluginEnvironmentProviderRequestOwner,
    operationId: string,
    run: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    owner.signal.throwIfAborted()
    if (this.active.has(operationId)) {
      throw new Error('This environment operation is already in progress')
    }
    if (this.active.size >= 8) {
      throw new Error('Too many environment operations are running on this host')
    }
    const operation = { key: owner.key, controller: new AbortController() }
    this.active.set(operationId, operation)
    try {
      return await run(AbortSignal.any([owner.signal, operation.controller.signal]))
    } finally {
      if (this.active.get(operationId) === operation) {
        this.active.delete(operationId)
      }
    }
  }

  cancel(key: string, operationId: string): boolean {
    const operation = this.active.get(operationId)
    if (!operation || operation.key !== key) {
      return false
    }
    operation.controller.abort()
    return true
  }

  revoke(key: string): void {
    for (const operation of this.active.values()) {
      if (operation.key === key) {
        operation.controller.abort()
      }
    }
  }
}
