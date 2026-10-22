import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentSessionContinuationContext } from '../../../shared/agent-session-wire'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { withoutInheritedClaudeConfigDir } from '../../claude/claude-config-dir-pin'
import { agentSessionPinnedLaunchDirectory } from '../../runtime/agent-session-record-launch-directory'
import { structuredSessionNativeContext } from '../../runtime/structured-session-recovery-options'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'

export function continuationContextReader(
  deps: StructuredAgentSessionHostDeps,
  conversation: (id: string) => Promise<StructuredAgentSessionHostSession>,
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
) {
  return async (input: {
    sessionId: string
    workspaceId: string
    expectedCursor: AgentJournalCursor
  }): Promise<AgentSessionContinuationContext> => {
    const superseded = { status: 'superseded' } as const
    if (!deps.store.getRecord(input.sessionId)) {
      return superseded
    }
    let session: StructuredAgentSessionHostSession
    try {
      session = await conversation(input.sessionId)
    } catch (error) {
      if (!deps.store.getRecord(input.sessionId)) {
        return superseded
      }
      throw error
    }
    const identity = () => {
      const record = deps.store.getRecord(input.sessionId)
      const cursor = session.journal.cursor()
      const frontier = session.journal.context.destructiveFrontier()
      if (
        !record ||
        record.location.workspaceId !== input.workspaceId ||
        record.location.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
        cursor.epoch !== input.expectedCursor.epoch ||
        cursor.sequence < input.expectedCursor.sequence ||
        frontier.sequence > input.expectedCursor.sequence
      ) {
        return null
      }
      return JSON.stringify([
        record.createdAt,
        cursor.epoch,
        frontier,
        record.provider,
        record.providerHandleChain,
        record.providerContextBoundary,
        record.accountHome,
        record.location,
        record.launchDirectory,
        record.lease.runtimeFence,
        record.rewind
      ])
    }
    const key = identity()
    const record = deps.store.getRecord(input.sessionId)
    if (!key || !record) {
      return superseded
    }
    const directory = async () =>
      agentSessionPinnedLaunchDirectory(deps.store.getRecord(input.sessionId) ?? record) ??
      (await deps.resolveWorkspacePath?.(record.location.workspaceId)) ??
      ''
    let cwd: string | undefined
    let transcriptPath: string | undefined
    try {
      cwd = await directory()
      if (record.rewind?.phase !== 'prepared' && record.rewind?.phase !== 'provider-succeeded') {
        const overlay = await deps.resolveLaunchEnv?.(record.provider)
        const launchEnv = {
          ...(record.provider === 'claude'
            ? withoutInheritedClaudeConfigDir(process.env)
            : process.env),
          ...overlay
        }
        transcriptPath = (
          await structuredSessionNativeContext(record, launchEnv, {
            cache: {},
            resolveWorkspacePath: async () => cwd ?? ''
          })
        )?.transcriptPath
      }
    } catch (error) {
      console.warn('Could not read saved chat context', error)
    }
    let finalDirectory: string | undefined
    try {
      finalDirectory = await directory()
    } catch (error) {
      console.warn('Could not read saved chat directory', error)
      transcriptPath = undefined
    }
    // No asynchronous work may follow this proof of the source that supplied the path.
    return sessions.get(input.sessionId) === session &&
      key === identity() &&
      (cwd === undefined || finalDirectory === undefined || cwd === finalDirectory)
      ? { status: 'current', ...(transcriptPath ? { transcriptPath } : {}) }
      : superseded
  }
}
