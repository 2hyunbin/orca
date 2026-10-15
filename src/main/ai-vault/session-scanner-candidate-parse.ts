import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { AntigravityWorkspaceResolver } from './session-scanner-antigravity-history'
import { getSessionParseCacheEntry } from './session-parse-cache-store'
import {
  parseAgentSessionFileCached,
  type SessionParseReadRequirement,
  type SessionParseStats
} from './session-scanner-parse-cache'
import type { SessionFileCandidate, SessionParseResult } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'
import { describeSkippedTranscriptRecords } from './session-transcript-record-budget'

// One listed transcript: parse it through the cache, then stamp the scanning host.
export async function parseSessionCandidate(
  candidate: SessionFileCandidate,
  args: {
    platform: NodeJS.Platform
    executionHostId: ExecutionHostId
    parseStats: SessionParseStats
    requireRead?: SessionParseReadRequirement
    antigravityWorkspaceResolver?: AntigravityWorkspaceResolver
    signal?: AbortSignal
  }
): Promise<SessionParseResult> {
  const { platform, executionHostId, antigravityWorkspaceResolver } = args
  try {
    let session = await parseAgentSessionFileCached(
      candidate,
      platform,
      args.parseStats,
      args.requireRead,
      args.signal
    )
    if (session && candidate.antigravityHistoryPath && antigravityWorkspaceResolver) {
      session = await antigravityWorkspaceResolver.enrich(session, candidate.antigravityHistoryPath)
    }
    return {
      session: session ? withSessionExecutionHost(session, executionHostId) : null,
      issue: skippedRecordIssue(candidate, executionHostId)
    }
  } catch (err) {
    return {
      session: null,
      issue: {
        executionHostId,
        agent: candidate.agent,
        path: candidate.file.path,
        message: errorMessage(err)
      }
    }
  }
}

// The session still listed, but part of it did not: report the loss as a notice
// so the panel does not count it as a skipped transcript file.
function skippedRecordIssue(
  candidate: SessionFileCandidate,
  executionHostId: ExecutionHostId
): AiVaultScanIssue | null {
  const skipped = getSessionParseCacheEntry(candidate.file.path)?.resume?.skippedRecords
  const message = skipped ? describeSkippedTranscriptRecords(skipped) : null
  if (message === null) {
    return null
  }
  return {
    executionHostId,
    agent: candidate.agent,
    kind: 'notice',
    path: candidate.file.path,
    message
  }
}

function withSessionExecutionHost(
  session: AiVaultSession,
  executionHostId: ExecutionHostId
): AiVaultSession {
  if (session.executionHostId === executionHostId) {
    return session
  }
  return {
    ...session,
    executionHostId,
    id: `${executionHostId}:${session.agent}:${session.sessionId}:${session.filePath}`
  }
}
