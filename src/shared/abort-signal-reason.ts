export function abortSignalReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason
  }
  return Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
}

export function throwIfSignalAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortSignalReason(signal)
  }
}

export function waitForPromiseWithSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  createAbortError: (signal: AbortSignal) => Error = abortSignalReason
): Promise<T> {
  if (!signal) {
    return promise
  }
  if (signal.aborted) {
    // Observe abandoned work so its later rejection stays handled.
    void promise.catch(() => undefined)
    return Promise.reject(createAbortError(signal))
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (complete: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      signal.removeEventListener('abort', onAbort)
      complete()
    }
    const onAbort = (): void => finish(() => reject(createAbortError(signal)))
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    )
  })
}
