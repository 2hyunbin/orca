import { MOBILE_RELAY_CLOSE_CODE } from '../../../shared/mobile-relay-close-codes'

export class RelayControlClosedError extends Error {
  constructor(
    readonly closeCode: number,
    controlErrorCode: string | null
  ) {
    super(
      controlErrorCode
        ? `relay_control_error_${controlErrorCode}`
        : `relay_control_closed_${closeCode}`
    )
  }
}

// Mirrors the cell's no-rejoin codes: the cell moved this host off, so redialing it is pointless.
export function isCellRedirectCloseCode(code: number): boolean {
  return code === MOBILE_RELAY_CLOSE_CODE.WRONG_CELL || code === MOBILE_RELAY_CLOSE_CODE.DRAINING
}

export function isCellRedirect(error: unknown): boolean {
  return error instanceof RelayControlClosedError && isCellRedirectCloseCode(error.closeCode)
}
