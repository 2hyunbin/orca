// What the runtime does when a provider settles a dispatch after the fact. It runs off the request
// that caused it, so its failure has nobody to return to and is logged instead. A late settlement's
// promise settles once its write landed or failed, so a provider can re-check what it kept.

import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

type DispatchFollowUpHost = Pick<StructuredAgentSessionHost, 'settleLateDispatch'>

export function createStructuredAgentSessionDispatchFollowUps(input: {
  /** Null until the host is built: the adapters that call these are built first. */
  host: () => DispatchFollowUpHost | null
  logger: StructuredAgentSessionLogger
}): {
  onDispatchSettledLate: (
    settlement: Parameters<StructuredAgentSessionHost['settleLateDispatch']>[0]
  ) => Promise<void> | undefined
} {
  const { logger } = input
  return {
    onDispatchSettledLate: (settlement) =>
      input
        .host()
        ?.settleLateDispatch(settlement)
        .catch((error: unknown) =>
          logger.warn('settling a dispatch the provider answered late failed', {
            scope: 'late-settlement',
            sessionId: settlement.sessionId,
            error
          })
        )
  }
}
