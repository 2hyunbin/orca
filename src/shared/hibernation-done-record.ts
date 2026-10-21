import type { SleepingAgentSessionRecord } from './agent-session-resume'

// Why not activationTreatsNoteAsFinished: a live+done note is a finished turn's idle anchor for a running pane, not sleep.
export function isHibernationDoneRecord(record: SleepingAgentSessionRecord): boolean {
  return (
    (record.origin === undefined || record.origin === 'worktree-sleep') && record.state === 'done'
  )
}
