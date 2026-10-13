import type { AiVaultListResult } from './ai-vault-types'
import type {
  AiVaultSelectedSessionSource,
  AiVaultResolveSessionResult
} from './ai-vault-selected-session'
import type { ExecutionHostId } from './execution-host'

export function selectedSessionFromLegacyList(
  result: AiVaultListResult,
  source: AiVaultSelectedSessionSource,
  executionHostId: ExecutionHostId
): AiVaultResolveSessionResult {
  const row = result.sessions.find(
    (session) =>
      !session.subagent &&
      (source.kind === 'chat'
        ? session.structuredSession?.sessionId === source.sessionId
        : session.agent === source.agent && session.sessionId === source.providerSessionId)
  )
  if (row) {
    return { status: 'ready', session: { ...row, executionHostId } }
  }
  const issue = result.issues.find(
    (candidate) =>
      candidate.kind !== 'notice' &&
      (source.kind === 'chat' || candidate.agent === source.agent || candidate.kind === 'host')
  )
  if (issue) {
    throw new Error(issue.message)
  }
  return { status: 'missing' }
}
