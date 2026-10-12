// Retiring a structured agent session's chat tab, so user closes and orchestration settlements
// (stop / release / discard) retire it the same way, rather than leaving a dead chat tab behind
// that re-attaches the session when opened.

/**
 * Retires a settled structured worker's chat tab, and cannot fail the settlement that called it.
 *
 * Every caller runs this AFTER it has already proven the session's close, so a snapshot problem
 * here must never be able to turn a proven stop into `release_unknown`: the runtime method is
 * called optionally (a runtime double or an older surface may not have it) and any throw is
 * swallowed. It talks to no renderer, so the startup release reconciler can call it too.
 */
export function retireSettledStructuredWorkerTab(
  sessionId: string,
  runtime:
    | { retireStructuredAgentSessionTabFromSnapshot?: (sessionId: string) => boolean }
    | undefined
): void {
  try {
    runtime?.retireStructuredAgentSessionTabFromSnapshot?.(sessionId)
  } catch (error) {
    console.warn('[orchestration] structured worker tab retirement failed', sessionId, error)
  }
}
