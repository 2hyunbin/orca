import type {
  ClaudeSession,
  ClaudeStructuredSessionAdapterDeps
} from './claude-structured-session-state'
import { settleClaudeTurnEndWaiters } from './claude-request-end-wait'
import { isRootClaudeFrame } from './claude-turn-opening'

export function claudeTurnResumePointWriter(
  sessionId: string,
  sessions: ReadonlyMap<string, ClaudeSession>,
  deps: Pick<ClaudeStructuredSessionAdapterDeps, 'persistResumePoint'>
) {
  return (
    session: ClaudeSession | null,
    message: Record<string, unknown>,
    leafUuid: string | null
  ): void => {
    if (session && message.type === 'result' && isRootClaudeFrame(message)) {
      persistClaudeTurnResumePoint(
        sessionId,
        session,
        deps,
        () => sessions.get(sessionId) === session,
        leafUuid
      )
    }
  }
}

/**
 * Record a completed turn: its leaf becomes the one close and exit persist, and the durable point
 * advances in place so an owner that dies before its close path runs keeps it. Writes run one at a
 * time, and a failure is only logged: this is bookkeeping and must never fail the turn.
 */
function persistClaudeTurnResumePoint(
  sessionId: string,
  session: ClaudeSession,
  deps: Pick<ClaudeStructuredSessionAdapterDeps, 'persistResumePoint'>,
  isCurrent: () => boolean,
  leafUuid: string | null
): void {
  // Ending a request never waits for optional history or durable bookkeeping.
  settleClaudeTurnEndWaiters(session)
  if (session.closeFinalization || session.closeFinalized || !isCurrent()) {
    return
  }
  const translator = session.translator
  if (
    !session.initialization.history.covered ||
    !translator?.finalOutputAdmitted ||
    translator.currentTurnId !== null ||
    translator.pendingStreamedBlocks > 0
  ) {
    return
  }
  const persist = deps.persistResumePoint
  if (leafUuid === null || session.resumePointWrite?.leafUuid === leafUuid) {
    return
  }
  const written = session.events
    ?.written?.()
    .catch((error: unknown) => ({ ok: false as const, error }))
  if (!written) {
    return
  }
  const previous = session.resumePointWrite?.settled ?? Promise.resolve()
  const write: NonNullable<ClaudeSession['resumePointWrite']> = {
    leafUuid,
    settled: previous
      .then(async () => {
        const result = await written
        if (!result.ok) {
          throw result.error
        }
        if (!isCurrent()) {
          return
        }
        session.turnEndLeafUuid = leafUuid
        await persist?.({
          sessionId,
          providerSessionId: session.providerSessionId,
          leafUuid,
          fence: session.fence
        })
      })
      .catch((error: unknown) => {
        console.warn('[claude-resume-point] turn-end resume point was not persisted:', {
          sessionId,
          leafUuid,
          error
        })
        // Forget the failed leaf so the next turn end retries it even when the leaf has not moved.
        if (session.resumePointWrite === write) {
          session.resumePointWrite = undefined
        }
      })
  }
  session.resumePointWrite = write
}

/** Close and exit persist the last completed turn, after any in-flight turn-end write settles. */
export async function settledClaudeTurnEndLeaf(session: ClaudeSession): Promise<string | null> {
  await session.resumePointWrite?.settled
  return session.turnEndLeafUuid
}
