import { candidateFileTime } from './antigravity-transcript-candidates'
import type { AiVaultRowObserver } from '../../shared/ai-vault-scan-rows'
import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { ScannedSessionCollection, dedupeScannedSessions } from './session-root-dedup'
import type { AntigravityWorkspaceResolver } from './session-scanner-antigravity-history'
import { parseAgentSessionFileCached, type SessionParseStats } from './session-scanner-parse-cache'
import { getSessionParseCacheEntry } from './session-parse-cache-store'
import { describeSkippedTranscriptRecords } from './session-transcript-record-budget'
import { canStopParsingSessions } from './session-scan-cutoff'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { recordSessionScanIssue } from './session-scan-issues'
import { errorMessage } from './session-scanner-values'
import type { SessionFileCandidate, SessionParseResult } from './session-scanner-types'

const SESSION_PARSE_CONCURRENCY = 8

export async function parseSessionCandidates(args: {
  candidates: SessionFileCandidate[]
  limit: number
  platform: NodeJS.Platform
  executionHostId: ExecutionHostId
  issues: AiVaultScanIssue[]
  parseStats: SessionParseStats
  signal?: AbortSignal
  antigravityWorkspaceResolver?: AntigravityWorkspaceResolver
  observeRows?: AiVaultRowObserver
}): Promise<AiVaultSession[]> {
  const sessions = new ScannedSessionCollection()
  const completed = new Map<number, AiVaultSession>()
  const readRows = (): AiVaultSession[] => dedupeScannedSessions([
    ...sessions.values(),
    ...[...completed.entries()].sort(([a], [b]) => a - b).map(([, row]) => row)
  ])

  for (let index = 0; index < args.candidates.length;) {
    throwIfAiVaultScanCancelled(args.signal)
    if (
      canStopParsingSessions(sessions, args.limit, candidateFileTime(args.candidates[index]?.file))
    ) {
      break
    }

    const remaining = args.candidates.length - index
    const needed = Math.max(args.limit - sessions.size, 1)
    const batchSize = Math.min(SESSION_PARSE_CONCURRENCY, needed, remaining)
    const batch = args.candidates.slice(index, index + batchSize)
    const results = await Promise.all(
      batch.map(async (candidate, ordinal) => {
        const result = await parseSessionCandidate(
          candidate,
          args.platform,
          args.executionHostId,
          args.parseStats,
          args.antigravityWorkspaceResolver,
          args.signal
        )
        if (result.session && !args.signal?.aborted && args.observeRows) {
          completed.set(ordinal, result.session)
          try {
            args.observeRows(readRows)
          } catch {
            // Observers own presentation, never candidate admission.
          }
        }
        return result
      })
    )
    // An abort can land while a batch settles: a read it cut short is not that
    // file's issue, and a partial parse must never be cached or returned.
    throwIfAiVaultScanCancelled(args.signal)

    completed.clear()
    for (const result of results) {
      if (result.issue) {
        recordSessionScanIssue(args.issues, result.issue)
      }
      if (result.session) {
        sessions.add(result.session)
      }
    }

    index += batchSize
  }

  return [...sessions.values()]
}

async function parseSessionCandidate(
  candidate: SessionFileCandidate,
  platform: NodeJS.Platform,
  executionHostId: ExecutionHostId,
  parseStats: SessionParseStats,
  antigravityWorkspaceResolver?: AntigravityWorkspaceResolver,
  signal?: AbortSignal
): Promise<SessionParseResult> {
  try {
    let session = await parseAgentSessionFileCached(
      candidate,
      platform,
      parseStats,
      undefined,
      signal
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
