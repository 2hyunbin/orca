/** What a managed-server setup that stopped short shows under its SSH host. */
import { isUnconfirmedSshCommandTermination } from './remote-exec/remote-exec-command'

// Bounds a failure's detail; the host log tail inside it is already capped.
const MAX_FAILURE_DETAIL_CHARS = 16_000

export type SetupFailure = {
  detail: string
  /** Contact was lost mid-setup: nothing proves the host failed, so it is never called a failure. */
  contactLost?: true
}

export function setupFailure(failure: unknown): SetupFailure {
  return {
    detail: failure instanceof Error ? failure.message : String(failure),
    ...(lostContact(failure) ? { contactLost: true as const } : {})
  }
}

export function boundedDetail(text: string): string {
  return text.length > MAX_FAILURE_DETAIL_CHARS ? `…${text.slice(-MAX_FAILURE_DETAIL_CHARS)}` : text
}

// Why the cause chain: install steps wrap the transport error they hit (e.g. out-of-space checks).
function lostContact(failure: unknown, depth = 0): boolean {
  if (isUnconfirmedSshCommandTermination(failure)) {
    return true
  }
  return depth < 4 && failure instanceof Error && lostContact(failure.cause, depth + 1)
}
