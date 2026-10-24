import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
// What a host's restart-resume surface offers: teardown's offer recording, the offer list and its
// actions, and Continue on a cut reply.

import type { AgentSessionResumeTrigger } from '../../../shared/agent-session-resume-marker'
import type { createInterruptedContinuation } from './structured-agent-session-interrupted-continuation'
import type { StructuredAgentSessionContinuationOutcome } from './structured-agent-session-restart-continuation'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-restart-resume-runner'
import type {
  StructuredAgentSessionRestartAudience,
  StructuredAgentSessionResumeCandidate,
  StructuredAgentSessionResumeFailure
} from './structured-agent-session-restart-resume-set'

export type StructuredAgentSessionRestartResume = {
  /** Snapshot before Stop, confirm proven exit, then persist confirmed offers together. */
  beginTeardown: (trigger: AgentSessionResumeTrigger) => void
  captureBeforeStop: (sessionId: string) => void
  confirmStopped: (sessionId: string) => void
  recordMarkers: () => Promise<void>
  list: (
    audience?: StructuredAgentSessionRestartAudience
  ) => Promise<StructuredAgentSessionResumeCandidate[]>
  listFailures: (
    audience?: StructuredAgentSessionRestartAudience
  ) => Promise<StructuredAgentSessionResumeFailure[]>
  /** Unnamed actions continue visible offers; named actions may also retry selected failures. */
  continueAfterRestart: (
    sessionIds: readonly string[] | undefined,
    owner: string,
    audience?: StructuredAgentSessionRestartAudience
  ) => Promise<{
    resumed: StructuredAgentSessionResumeOutcome[]
    continued: StructuredAgentSessionContinuationOutcome[]
    skipped?: string[]
    sessions?: StructuredAgentSessionResumeCandidate[]
    failed?: StructuredAgentSessionResumeFailure[]
  }>
  /** Dismiss visible records only; preserve newer-chat records this host never lists. */
  dismiss: (
    sessionIds?: readonly string[],
    audience?: StructuredAgentSessionRestartAudience
  ) => Promise<number>
  onAgentStarted: (sessionId: string) => void
  noteReadResult: (
    sessionId: string,
    result: { openRefusal?: AgentSessionWireRefusal } | null
  ) => void
  beforeConversationClose: (sessionId: string) => void
  /** Continue on a reply an Orca stop cut off, offer or not; the send itself retires any offer. */
  continueInterrupted: ReturnType<typeof createInterruptedContinuation>
}
