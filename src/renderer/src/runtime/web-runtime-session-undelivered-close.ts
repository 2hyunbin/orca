// A paired-tab close that never reached its host: sending it again is the user's own close.
import { RuntimeRpcCallError } from './runtime-rpc-result'

// Why these and a bare rejection only: they mean the close never reached the host, so sending it
// again is the user's own close. A structured refusal (e.g. a re-paired host) is an answer.
// A Disconnect is answered by this client, not the host, so a tab closed meanwhile stays closed.
const UNDELIVERED_CLOSE_CODES = new Set([
  'runtime_manually_disconnected',
  'runtime_unavailable',
  'remote_runtime_unavailable',
  'runtime_timeout',
  'remote_runtime_timeout'
])

export function isUndeliveredCloseFailure(error: unknown): boolean {
  return !(error instanceof RuntimeRpcCallError) || UNDELIVERED_CLOSE_CODES.has(error.code)
}
