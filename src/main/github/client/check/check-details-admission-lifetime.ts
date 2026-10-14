import {
  createGhLogicalLifetime,
  type GhCaptureLifetimeHooks
} from '../../../git/command-runner/gh-capture-lifetime'
import { createCheckDetailsAbortError, waitForCheckDetailsResolution } from './check-details-abort'

export function createCheckDetailsAdmissionLifetime(release: () => void): {
  retainUntil: (terminated: Promise<void>) => void
  finish: () => void
} {
  const lifetime = createGhLogicalLifetime()
  void lifetime.terminated.then(release)
  return {
    retainUntil: lifetime.hooks.onTerminationPending,
    finish: lifetime.seal
  }
}

export function runCheckDetailsCall<T>(
  run: (hooks: GhCaptureLifetimeHooks) => Promise<T>,
  signal: AbortSignal,
  retainUntil: (terminated: Promise<void>) => void
): { result: Promise<T>; terminated: Promise<void> } {
  const lifetime = createGhLogicalLifetime()
  retainUntil(lifetime.terminated)
  const operation = Promise.resolve()
    .then(() => {
      if (signal.aborted) {
        throw createCheckDetailsAbortError()
      }
      return run(lifetime.hooks)
    })
    .finally(lifetime.seal)
  return {
    result: waitForCheckDetailsResolution(operation, signal),
    terminated: lifetime.terminated
  }
}
