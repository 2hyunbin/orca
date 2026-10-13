import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { SELECTED_SESSION_LOOKUP_TIMEOUT_MS } from '../../shared/ai-vault-selected-session'

export async function withSelectedSessionDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  caller?: AbortSignal,
  timeoutMs = SELECTED_SESSION_LOOKUP_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController()
  const cancel = () => controller.abort(caller?.reason)
  if (caller?.aborted) {
    cancel()
  } else {
    caller?.addEventListener('abort', cancel, { once: true })
  }
  const timer = setTimeout(
    () => controller.abort(new Error('Conversation lookup timed out.')),
    timeoutMs
  )
  timer.unref?.()
  try {
    controller.signal.throwIfAborted()
    return await waitForPromiseWithSignal(run(controller.signal), controller.signal)
  } finally {
    clearTimeout(timer)
    caller?.removeEventListener('abort', cancel)
  }
}
