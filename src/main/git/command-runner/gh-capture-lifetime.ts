import { createAbortError } from './abort-error'

export type GhCaptureLifetimeHooks = {
  onTerminationPending: (terminated: Promise<void>) => void
}

export function assertGhCallActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError()
  }
}

export function waitForGhTermination(
  terminated: Promise<void>,
  signal: AbortSignal
): Promise<void> {
  assertGhCallActive(signal)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      signal.removeEventListener('abort', onAbort)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const onAbort = (): void => finish(createAbortError())
    signal.addEventListener('abort', onAbort, { once: true })
    void terminated.then(() => finish())
  })
}

export function createGhLogicalLifetime(forward?: GhCaptureLifetimeHooks): {
  hooks: GhCaptureLifetimeHooks
  terminated: Promise<void>
  seal: () => void
  waitPending: (signal?: AbortSignal) => Promise<void>
  capture: () => () => void
} {
  const pending = new Set<Promise<void>>()
  let sealed = false
  const { promise: terminated, resolve: complete } = Promise.withResolvers<void>()
  forward?.onTerminationPending(terminated)
  const finish = (): void => {
    if (sealed && pending.size === 0) {
      complete()
    }
  }
  const hooks: GhCaptureLifetimeHooks = {
    onTerminationPending: (child) => {
      pending.add(child)
      void child.then(() => {
        pending.delete(child)
        finish()
      })
    }
  }
  return {
    hooks,
    terminated,
    seal: () => {
      sealed = true
      finish()
    },
    waitPending: async (signal) => {
      assertGhCallActive(signal)
      if (pending.size === 0) {
        return
      }
      if (!signal) {
        throw new Error('GitHub command termination is unverifiable.')
      }
      await waitForGhTermination(
        Promise.all(pending).then(() => {}),
        signal
      )
      assertGhCallActive(signal)
    },
    capture: () => {
      const { promise: child, resolve: report } = Promise.withResolvers<void>()
      hooks.onTerminationPending(child)
      return report
    }
  }
}
