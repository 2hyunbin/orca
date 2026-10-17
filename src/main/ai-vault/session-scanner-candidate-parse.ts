import { candidateFileTime } from './antigravity-transcript-candidates'
import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { ScannedSessionCollection } from './session-root-dedup'
import type { AntigravityWorkspaceResolver } from './session-scanner-antigravity-history'
import {
  parseAgentSessionFileCached,
  parseListedSessionFile,
  type SessionParseStats
} from './session-scanner-parse-cache'
import { recordSessionScanIssue } from './session-scan-issues'
import { getSessionParseCacheEntry } from './session-parse-cache-store'
import { describeSkippedTranscriptRecords } from './session-transcript-record-budget'
import { canStopParsingSessions } from './session-scan-cutoff'
import type { SessionFileCandidate, SessionParseResult } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { noteAiVaultScanFilesRead } from './ai-vault-scan-progress'

const SESSION_PARSE_CONCURRENCY = 8

/** Parses newest-first candidates until `limit` sessions, stopping once older files cannot rank. */
export async function parseSessionCandidates(args: {
  candidates: SessionFileCandidate[]
  limit: number
  platform: NodeJS.Platform
  executionHostId: ExecutionHostId
  issues: AiVaultScanIssue[]
  parseStats: SessionParseStats
  signal?: AbortSignal
  antigravityWorkspaceResolver?: AntigravityWorkspaceResolver
}): Promise<AiVaultSession[]> {
  const sessions = new ScannedSessionCollection()

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
      batch.map((candidate) =>
        parseSessionCandidate(candidate, {
          platform: args.platform,
          executionHostId: args.executionHostId,
          parseStats: args.parseStats,
          antigravityWorkspaceResolver: args.antigravityWorkspaceResolver,
          listed: true,
          signal: args.signal
        })
      )
    )
    // An abort can land while a batch settles: a read it cut short is not that
    // file's issue, and a partial parse must never be cached or returned.
    throwIfAiVaultScanCancelled(args.signal)
    noteAiVaultScanFilesRead(args.signal, batch.length)

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

export async function parseSessionCandidate(
  candidate: SessionFileCandidate,
  context: {
    platform: NodeJS.Platform
    executionHostId: ExecutionHostId
    parseStats: SessionParseStats
    antigravityWorkspaceResolver?: AntigravityWorkspaceResolver
    // Unlisted parses keep the parse cache's count bound (see session-parse-cache-store.ts).
    listed: boolean
    signal?: AbortSignal
  }
): Promise<SessionParseResult> {
  const { platform, executionHostId, parseStats, antigravityWorkspaceResolver, signal } = context
  try {
    let session = context.listed
      ? await parseListedSessionFile(candidate, platform, parseStats, signal)
      : await parseAgentSessionFileCached(candidate, platform, parseStats, undefined, signal)
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
  const entry = getSessionParseCacheEntry(candidate.file.path)
  const skipped = entry?.resume?.skippedRecords ?? entry?.skippedRecords
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
