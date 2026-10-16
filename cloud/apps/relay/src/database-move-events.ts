// One JSON line per phase of the database move tool. Fields are counts, names and timestamps:
// no URL, password, or row content is ever passed here.
export function logMoveEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({ event: `orca_relay_move_${event}`, at: new Date().toISOString(), ...fields })
  )
}

// A precondition or check the tool refuses on. The message is the tool's own text, safe to print.
export class MoveRefusal extends Error {
  constructor(
    readonly reason: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(reason)
  }
}

// Driver and network errors can quote connection settings, so only a refusal's own text, a
// SQLSTATE and a server message (which never echoes credentials) are reported.
export function describeMoveError(error: unknown): Record<string, unknown> {
  if (error instanceof MoveRefusal) return { reason: error.reason, ...error.details }
  if (typeof error !== 'object' || error === null) return { error: 'unknown' }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
  const serverMessage =
    'severity' in error && 'message' in error && typeof error.message === 'string'
      ? error.message
      : undefined
  const name = error instanceof Error ? error.name : 'unknown'
  // Our own error tokens (snake_case words) carry no values, so they are safe to print.
  const token =
    error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : undefined
  return {
    error: name,
    ...(code ? { code } : {}),
    ...(serverMessage ? { serverMessage } : {}),
    ...(token ? { token } : {})
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}
