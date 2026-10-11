export function sessionTabCloseAnswerOutcome(answer: unknown): 'closed' | 'failed' {
  if (
    typeof answer !== 'object' ||
    answer === null ||
    !('refused' in answer) ||
    answer.refused !== true
  ) {
    return 'closed'
  }
  if ('snapshotRepublished' in answer && answer.snapshotRepublished === true) {
    return 'failed'
  }
  const reason = 'refusalReason' in answer ? answer.refusalReason : undefined
  return reason === 'live-host-pty' || reason === 'retirement-owner' ? 'closed' : 'failed'
}
