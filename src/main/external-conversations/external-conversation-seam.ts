/** Why a seam is disposed; later refusals settle held work with it. */
export type ExternalConversationSeamDisposeReason = 'connectors_disabled'

/**
 * The connector seam for one enabled period. Turning connectors off disposes it and turning them
 * on builds a fresh one, so nothing it registers outlives the period that registered it.
 */
export class ExternalConversationSeam {
  private readonly abort = new AbortController()

  /** Deferred work rechecks this before each write, so nothing writes after a disable. */
  get signal(): AbortSignal {
    return this.abort.signal
  }

  dispose(reason: ExternalConversationSeamDisposeReason): void {
    this.abort.abort(reason)
  }
}
