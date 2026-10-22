import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { executionHostIdForStructuredTarget } from '@/runtime/structured-agent-session-owner'
import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'
export type HostOfferRead = {
  candidates: readonly ResumeCandidate[]
  failed: readonly ResumeFailure[]
  available: boolean
}

/** The host's answer as this side understands it. `failed` is optional on the wire: an older host
 *  never sends it, and its absence means nothing to show, not an invalid answer. */
export type HostOfferPayload = { sessions?: unknown; failed?: unknown }

export function failedFrom(payload: HostOfferPayload): ResumeFailure[] {
  // SAFETY: the host is the single writer of this shape; a malformed row is a host bug, not input.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see above.
  return Array.isArray(payload.failed) ? (payload.failed as ResumeFailure[]) : []
}
export type NativeChatRestartOffer = Readonly<{
  candidates: readonly ResumeCandidate[]
  /** Acted-on offers whose agent did not carry on, as the host still records them. */
  failed: readonly ResumeFailure[]
  /** Stamped when the list arrived. Row ages read against this rather than a render-time
   *  `Date.now()`, so they stay stable across re-renders and the render stays pure. */
  listedAt: number
}>

export const EMPTY: NativeChatRestartOffer = { candidates: [], failed: [], listedAt: 0 }

export function restartOfferOnTarget(
  answer: NativeChatRestartOffer,
  target: RuntimeClientTarget
): NativeChatRestartOffer {
  if (target.kind === 'local') {
    return answer
  }
  const onThisHost = <T extends ResumeCandidate>(rows: readonly T[]): T[] =>
    rows.map((row) => ({ ...row, executionHostId: executionHostIdForStructuredTarget(target) }))
  return { ...answer, candidates: onThisHost(answer.candidates), failed: onThisHost(answer.failed) }
}
