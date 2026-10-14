import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'

export function createCheckDetailsAbortError(): Error {
  const error = new Error('Check details request was cancelled.')
  error.name = 'AbortError'
  return error
}

export function assertCheckDetailsActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createCheckDetailsAbortError()
  }
}

export function waitForCheckDetailsResolution<T>(
  operation: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  return waitForPromiseWithSignal(operation, signal, createCheckDetailsAbortError)
}
