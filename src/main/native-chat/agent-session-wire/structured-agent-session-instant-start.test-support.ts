// Fake children answer the host-awaited protocol open immediately.

import type {
  StructuredAgentSessionAdapter,
  StructuredAgentSessionLifecycleEvent
} from './structured-agent-session-adapter'

/** A report read at this revision is never admitted, so the fake's empty report persists nothing,
 *  as a fake with no options to report never did. */
const NO_OPTIONS_REPORTED = -1

export function startsWhenPublished<A extends StructuredAgentSessionAdapter>(
  adapter: A,
  _host: () => { handleAdapterEvent(event: StructuredAgentSessionLifecycleEvent): Promise<void> }
): A {
  let generations = 0
  const acquire: StructuredAgentSessionAdapter['acquire'] = async (input) => {
    const acquired = await adapter.acquire(input)
    const acquisitionGeneration = acquired.acquisitionGeneration ?? `instant-start-${++generations}`
    return { ...acquired, acquisitionGeneration, providerChildPhase: 'starting' as const }
  }
  return {
    ...adapter,
    acquire,
    open:
      adapter.open ??
      (async () => ({
        reportedOptions: { model: '' },
        restoreSkippedOptions: [],
        optionRevision: NO_OPTIONS_REPORTED
      }))
  }
}
