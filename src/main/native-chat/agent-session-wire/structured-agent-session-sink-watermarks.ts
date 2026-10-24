import type { StructuredAgentSessionSinkWatermarks } from './structured-agent-session-event-sink'

export const DEFAULT_WATERMARKS: StructuredAgentSessionSinkWatermarks = {
  pauseQueuedBytes: 16 * 1024 * 1024,
  maxQueuedBytes: 32 * 1024 * 1024,
  lowQueuedBytes: 8 * 1024 * 1024,
  pauseQueuedOperations: 512,
  maxQueuedOperations: 1_024,
  lowQueuedOperations: 256,
  maxLifecycleQueuedBytes: 16 * 1024 * 1024,
  maxLifecycleQueuedOperations: 1_024
}
