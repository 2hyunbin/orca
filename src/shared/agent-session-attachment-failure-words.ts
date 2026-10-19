import type {
  AgentSessionAttachmentProblem,
  AgentSessionAttachmentProblemReason
} from './agent-session-failure'
import type { AgentSessionFailureSay } from './agent-session-failure-copy'

const BYTES_PER_MB = 1024 * 1024

/** The sentence for an attachment a chat refused, from the problem the host found. */
export function attachmentProblemSentence(
  say: AgentSessionFailureSay,
  agent: { agent: string },
  problem: AgentSessionAttachmentProblem
): string {
  return ATTACHMENT_SENTENCES[problem.reason](say, agent, problem)
}

// The number only; each language's sentence carries its own unit.
function megabytes(bytes: number): string {
  return String(Math.round((bytes / BYTES_PER_MB) * 10) / 10)
}

const ATTACHMENT_SENTENCES = {
  empty: (say) => say('attachmentEmpty'),
  tooLarge: (say, _, { limit }) =>
    limit ? say('attachmentLargerThan', { size: megabytes(limit) }) : say('attachmentTooLarge'),
  tooMany: (say, agent, { limit }) =>
    limit ? say('attachmentAtMost', { ...agent, limit: String(limit) }) : say('attachmentTooMany'),
  totalTooLarge: (say, _, { limit }) =>
    limit
      ? say('attachmentTotalMoreThan', { size: megabytes(limit) })
      : say('attachmentTotalTooLarge'),
  unsupportedType: (say, agent) => say('attachmentUnsupportedType', agent),
  notAFile: (say) => say('attachmentNotAFile'),
  noSource: (say) => say('attachmentNoSource')
} satisfies Record<
  AgentSessionAttachmentProblemReason,
  (
    say: AgentSessionFailureSay,
    agent: { agent: string },
    problem: AgentSessionAttachmentProblem
  ) => string
>
