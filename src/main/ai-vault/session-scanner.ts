import { parseSessionCandidates } from './session-candidate-parser'
import type { AiVaultRowObserver } from '../../shared/ai-vault-scan-rows'
import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import { withSpan } from '../observability/tracer'
import { sessionSortTime } from './session-scanner-accumulator'
import { dedupeScannedSessions } from './session-root-dedup'
import {
  createAntigravityWorkspaceResolver,
  readLocalAntigravityHistory
} from './session-scanner-antigravity-history'
import { sessionCandidatesFromDiscoveries } from './session-scanner-candidates'
import { ensureSessionParseCacheLoaded } from './session-parse-cache-persistence'
import {
  createSessionParseStats,
  type SessionParseStats
} from './session-scanner-parse-cache'
import { recordSessionScanIssue } from './session-scan-issues'
import { discoverInScopeCwdBucketFiles } from './session-scanner-scope-discovery'
import {
  CLAUDE_CWD_BUCKET_LAYOUT,
  PI_CWD_BUCKET_LAYOUT,
  CODEBUDDY_CWD_BUCKET_LAYOUT
} from './session-cwd-bucket-layouts'
import { discoverAiVaultSessionSources } from './session-scanner-source-discovery'
import { cursorChatMetaRefusals, withCursorChatMetaScan } from './session-scanner-cursor-chat-meta'
import type {
  AiVaultScanOptions,
  SessionFileCandidate,
  SessionFileDiscovery
} from './session-scanner-types'
import { clampPositiveInteger } from './session-scanner-values'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { DEFAULT_AI_VAULT_SCAN_LIMIT } from '../../shared/ai-vault-session-depth'
import { withDevinSessionsDbScan } from './session-scanner-devin-db'
import { withOpenCodeSqliteScanScope } from './session-scanner-opencode-sqlite-scan-scope'

const SESSION_PARSE_CANDIDATE_MULTIPLIER = 2

/**
 * Scan all supported AI agent session stores and return a unified, sorted,
 * deduplicated list of sessions for the AI Vault panel. Discovers sessions
 * from file-based stores (Claude, Codex, Gemini, etc.) and SQLite-based
 * stores (OpenCode 1.17.x). Results are sorted by session sort time DESC
 * and truncated to `limit`.
 * @param options - Optional scan configuration (limits, custom dirs, platform).
 * @returns The list of sessions, scan issues, and a timestamp.
 */
export async function scanAiVaultSessions(
  options: AiVaultScanOptions = {},
  observeRows?: AiVaultRowObserver
): Promise<AiVaultListResult> {
  return withOpenCodeSqliteScanScope(() => scanAiVaultSessionStores(options, observeRows))
}

async function scanAiVaultSessionStores(
  options: AiVaultScanOptions,
  observeRows?: AiVaultRowObserver
): Promise<AiVaultListResult> {
  // The span makes scan cost visible in the local trace file: STA-1278-style
  // "one core pegged" reports need to show whether transcript scanning is the
  // subsystem burning CPU, and how much of each scan the cache absorbed.
  // The Cursor chat-meta scope spans discovery AND parse: its sibling meta.json
  // is looked up in both phases, and one scan must read the chats tree once.
  return withSpan('aiVault.scan', (span) =>
    withDevinSessionsDbScan(() =>
      withCursorChatMetaScan(async () => {
        const limit = options.unlimited
          ? Number.POSITIVE_INFINITY
          : clampPositiveInteger(options.limit, DEFAULT_AI_VAULT_SCAN_LIMIT)
        const limitPerAgent = options.unlimited
          ? Number.POSITIVE_INFINITY
          : clampPositiveInteger(options.limitPerAgent, limit * SESSION_PARSE_CANDIDATE_MULTIPLIER)
        const platform = options.platform ?? process.platform
        const executionHostId = options.executionHostId ?? LOCAL_EXECUTION_HOST_ID
        const issues: AiVaultScanIssue[] = []
        const parseStats = createSessionParseStats()
        const antigravityWorkspaceResolver = createAntigravityWorkspaceResolver((path) =>
          readLocalAntigravityHistory(path, options.signal)
        )
        // Why: persisted entries must be seeded before any candidate is parsed, or
        // the cold scan gains nothing from the cache file (#9210).
        throwIfAiVaultScanCancelled(options.signal)
        await ensureSessionParseCacheLoaded()
        const discoveries = await discoverAiVaultSessionSources({ options, limitPerAgent, issues })
        throwIfAiVaultScanCancelled(options.signal)

        const candidates = await sessionCandidatesFromDiscoveries(discoveries, options)

        const parsedSessions = await parseSessionCandidates({
          candidates: candidates.slice(0, limit * SESSION_PARSE_CANDIDATE_MULTIPLIER),
          limit,
          platform,
          executionHostId,
          issues,
          parseStats,
          signal: options.signal,
          antigravityWorkspaceResolver,
          observeRows: observeRows
            ? (read) => observeRows(() => [...read()].sort((a, b) => sessionSortTime(b) - sessionSortTime(a)).slice(0, limit))
            : undefined
        })

        const cappedSessions = dedupeScannedSessions(parsedSessions)
          .sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
          .slice(0, limit)

        const scopeSessions = await scanInScopeSessions({
          discoveries,
          scopePaths: options.scopePaths ?? [],
          limit,
          alreadyParsedFilePaths: new Set(cappedSessions.map((session) => session.filePath)),
          platform,
          executionHostId,
          issues,
          parseStats,
          signal: options.signal,
          observeRows: observeRows
            ? (read) => observeRows(() => mergeSessions(cappedSessions, [...read()]))
            : undefined
        })
        // Scope discovery can return without parsing anything, so an abort landing
        // here would otherwise persist and return a cancelled scan as complete.
        throwIfAiVaultScanCancelled(options.signal)
        for (const refusal of cursorChatMetaRefusals()) {
          // One issue per refused chats root, not one per Cursor transcript.
          recordSessionScanIssue(issues, {
            agent: 'cursor',
            path: refusal.chatsRoot,
            message: refusal.message
          })
        }

        span.setAttribute('candidates', candidates.length)
        span.setAttribute('reused', parseStats.reused)
        span.setAttribute('incremental', parseStats.incremental)
        span.setAttribute('fullParses', parseStats.fullParses)
        span.setAttribute('earlyStopped', parseStats.earlyStopped)
        span.setAttribute('bytesRead', parseStats.bytesRead)
        span.setAttribute('issues', issues.length)

        return {
          sessions: mergeSessions(cappedSessions, scopeSessions),
          issues: issues.map((issue) => ({ executionHostId, ...issue })),
          scannedAt: new Date().toISOString()
        }
      })
    )
  )
}

// In-scope sessions are guaranteed regardless of the recency cap, so the global
// (already capped) result and the scope result are unioned and de-duplicated by
// session id, then re-sorted DESC.
function mergeSessions(
  cappedSessions: AiVaultSession[],
  scopeSessions: AiVaultSession[]
): AiVaultSession[] {
  if (scopeSessions.length === 0) {
    return cappedSessions
  }
  const byId = new Map<string, AiVaultSession>()
  for (const session of cappedSessions) {
    byId.set(session.id, session)
  }
  for (const session of scopeSessions) {
    byId.set(session.id, session)
  }
  return [...byId.values()].sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
}

// Agents whose on-disk layout names a directory per cwd, so a scope's older
// sessions can be found without reading every transcript's header.
const CWD_BUCKET_LAYOUTS = [
  CLAUDE_CWD_BUCKET_LAYOUT,
  PI_CWD_BUCKET_LAYOUT,
  CODEBUDDY_CWD_BUCKET_LAYOUT
]

async function scanInScopeSessions(args: {
  discoveries: SessionFileDiscovery[]
  scopePaths: readonly string[]
  limit: number
  alreadyParsedFilePaths: ReadonlySet<string>
  platform: NodeJS.Platform
  executionHostId: ExecutionHostId
  issues: AiVaultScanIssue[]
  parseStats: SessionParseStats
  signal?: AbortSignal
  observeRows?: AiVaultRowObserver
}): Promise<AiVaultSession[]> {
  if (args.scopePaths.length === 0) {
    return []
  }
  const candidates: SessionFileCandidate[] = []
  for (const layout of CWD_BUCKET_LAYOUTS) {
    const files = await discoverInScopeCwdBucketFiles(layout, {
      rootDirs: args.discoveries
        .filter((discovery) => discovery.agent === layout.agent)
        .map((discovery) => discovery.rootDir),
      scopePaths: args.scopePaths,
      limit: args.limit,
      excludedFilePaths: args.alreadyParsedFilePaths,
      issues: args.issues
    })
    candidates.push(...files.map((file) => ({ agent: layout.agent, file, codexHome: null })))
  }
  if (candidates.length === 0) {
    return []
  }
  // Parse every in-scope candidate (limit === candidate count never early-stops).
  return parseSessionCandidates({
    candidates,
    limit: candidates.length,
    platform: args.platform,
    executionHostId: args.executionHostId,
    issues: args.issues,
    parseStats: args.parseStats,
    signal: args.signal,
    observeRows: args.observeRows
  })
}

