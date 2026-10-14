/**
 * After quiesce, proof that no terminal of a moved workspace still runs on this desktop's daemon
 * (mover design, section 3.3). The local daemon can prove exit, so only a census it answered can
 * say `exited`; one it could not answer is `unverifiable`, never a guess (AGENTS.md: SSH Use Case).
 */
import { parsePtySessionId } from '../../../shared/pty-session-id-format'
import type { SessionInfo } from '../../daemon/types'

export type WslMoveExitProof =
  | { verdict: 'exited' }
  | { verdict: 'live'; sessionIds: string[] }
  | { verdict: 'unverifiable'; reason: string }

export async function proveWslMoveTerminalsExited(
  listSessions: () => Promise<readonly Pick<SessionInfo, 'sessionId' | 'isAlive'>[]>,
  scope: {
    worktreeIds: ReadonlySet<string>
    /** The ids the moved panes recorded; covers a session whose id predates the minted format. */
    sessionIds: ReadonlySet<string>
  }
): Promise<WslMoveExitProof> {
  let sessions: readonly Pick<SessionInfo, 'sessionId' | 'isAlive'>[]
  try {
    sessions = await listSessions()
  } catch (error) {
    return {
      verdict: 'unverifiable',
      reason: error instanceof Error ? error.message : String(error)
    }
  }
  const live = sessions
    .filter((session) => {
      if (!session.isAlive) {
        return false
      }
      if (scope.sessionIds.has(session.sessionId)) {
        return true
      }
      const { worktreeId } = parsePtySessionId(session.sessionId)
      return worktreeId !== null && scope.worktreeIds.has(worktreeId)
    })
    .map((session) => session.sessionId)
  return live.length > 0 ? { verdict: 'live', sessionIds: live } : { verdict: 'exited' }
}
