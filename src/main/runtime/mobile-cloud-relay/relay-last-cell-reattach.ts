import type { RelayControlOrigin } from './relay-control-origin'
import type { RelayAssignment } from './relay-http-client'
import { RelayAssignRateGate } from './relay-assign-rate-gate'
import { isCellRedirect, isCellRedirectCloseCode } from './relay-control-closed-error'
import { MOBILE_RELAY_CLOSE_CODE } from '../../../shared/mobile-relay-close-codes'

// Spreads the hosts one cell loss dropped together before they redial it.
const REATTACH_JITTER_MS = 1_000
const REATTACH_GATE_KEY = 'last-cell'

export type RelayLastCellTarget = { assignment: RelayAssignment; relayJwt: string }

type RelayLastCellReattachOptions = {
  isCurrent: () => boolean
  random?: () => number
}

// Lets control recovery return to its cell while the director is unreachable.
export class RelayLastCellReattach {
  private origin: RelayControlOrigin | null = null
  // Paces reattaches like director assigns, so a flapping control cannot spin.
  private readonly gate = new RelayAssignRateGate()

  constructor(private readonly options: RelayLastCellReattachOptions) {}

  // Only a loss the cell did not decide (no redirect or auth close, no drain frame) is eligible.
  noteLoss(origin: RelayControlOrigin, closeCode: number, draining: boolean): void {
    const decided =
      closeCode === MOBILE_RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL ||
      isCellRedirectCloseCode(closeCode)
    this.origin = !decided && !draining ? origin : null
  }

  forget(origin?: RelayControlOrigin): void {
    if (!origin || this.origin === origin) {
      this.origin = null
    }
  }

  // The cell still verifies the held assignment, so a stale one costs one refused hello.
  async attempt(
    origin: RelayControlOrigin,
    directorError: unknown,
    target: () => RelayLastCellTarget | null,
    reattach: (target: RelayLastCellTarget) => Promise<void>
  ): Promise<void> {
    if (this.origin !== origin || !target()) {
      throw directorError
    }
    await this.gate.reserve(REATTACH_GATE_KEY, this.options.isCurrent)
    const random = this.options.random ?? Math.random
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.floor(random() * REATTACH_JITTER_MS))
    )
    // A drain, close or newer parked assignment may have landed during the wait.
    const current = this.origin === origin ? target() : null
    if (!current) {
      throw directorError
    }
    try {
      await reattach(current)
    } catch (error) {
      if (isCellRedirect(error)) {
        this.forget(origin)
      }
      if (this.options.isCurrent()) {
        console.warn(
          '[relay] last-cell reattach failed:',
          error instanceof Error ? error.message : String(error)
        )
      }
      // The director's error keeps its Retry-After for the backoff.
      throw directorError
    }
    this.forget(origin)
    console.warn('[relay] director unreachable; reattached control to the last cell')
  }
}
