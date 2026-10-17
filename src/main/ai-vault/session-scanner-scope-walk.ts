import { createAiVaultScopeCwdMatcher } from '../../shared/ai-vault-scope-cwd-match'
import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { noteAiVaultScanFilesRead, noteAiVaultScanReading } from './ai-vault-scan-progress'
import { noteSessionParseCacheListed, peekSessionParseCacheEntry } from './session-parse-cache-store'
import { ScannedSessionCollection } from './session-root-dedup'
import { recordSessionScanIssue } from './session-scan-issues'
import type { AntigravityWorkspaceResolver } from './session-scanner-antigravity-history'
import { parseSessionCandidate, parseSessionCandidates } from './session-scanner-candidate-parse'
import { discoveryFileCandidates, dropCodexHardlinkAliases } from './session-scanner-candidates'
import type { SessionParseStats } from './session-scanner-parse-cache'
import { discoverInScopeCwdBucketFiles } from './session-scanner-scope-discovery'
import type {
  AiVaultScanOptions,
  SessionFileCandidate,
  SessionFileDiscovery
} from './session-scanner-types'
import {
  AI_VAULT_SCOPE_CWD_SOURCES,
  pruneTranscriptHeadCwdCache,
  readTranscriptHeadCwd,
  scopeWalksAgentFiles
} from './session-scope-cwd'
import { sidecarUnchanged } from './session-sidecar-stat'

const SCOPE_WALK_BATCH_SIZE = 16

type ScopeScanArgs = {
  discoveries: readonly SessionFileDiscovery[]
  options: AiVaultScanOptions
  limit: number
  // The capped list's transcripts, already parsed and returned.
  alreadyParsedFilePaths: ReadonlySet<string>
  platform: NodeJS.Platform
  executionHostId: ExecutionHostId
  issues: AiVaultScanIssue[]
  parseStats: SessionParseStats
  antigravityWorkspaceResolver: AntigravityWorkspaceResolver
}

/**
 * The Workspace/Project sessions the recency cap left out, for every agent: each
 * one is found the way AI_VAULT_SCOPE_CWD_SOURCES says its cwd can be read.
 */
export async function scanInScopeSessions(args: ScopeScanArgs): Promise<AiVaultSession[]> {
  const scopePaths = args.options.scopePaths ?? []
  if (scopePaths.length === 0) {
    return []
  }
  const candidates: SessionFileCandidate[] = []
  for (const source of Object.values(AI_VAULT_SCOPE_CWD_SOURCES)) {
    if (source.kind !== 'bucket') {
      continue
    }
    const { layout } = source
    const files = await discoverInScopeCwdBucketFiles(layout, {
      rootDirs: args.discoveries
        .filter((discovery) => discovery.agent === layout.agent)
        .map((discovery) => discovery.rootDir),
      scopePaths,
      limit: args.limit,
      excludedFilePaths: args.alreadyParsedFilePaths,
      issues: args.issues
    })
    candidates.push(...files.map((file) => ({ agent: layout.agent, file, codexHome: null })))
  }
  const walked = await walkInScopeSessions(args, scopePaths)
  if (candidates.length === 0) {
    return walked
  }
  noteAiVaultScanReading(args.options.signal, candidates.length)
  // Parse every in-scope candidate (limit === candidate count never early-stops).
  const bucketed = await parseSessionCandidates({
    candidates,
    limit: candidates.length,
    platform: args.platform,
    executionHostId: args.executionHostId,
    issues: args.issues,
    parseStats: args.parseStats,
    signal: args.options.signal
  })
  return [...bucketed, ...walked]
}

/**
 * Agents without a cwd-per-directory layout: walks their files newest first,
 * skips a file only when its cached or opening-record cwd is known to be out of
 * scope, and counts what the parse then places in scope.
 */
async function walkInScopeSessions(
  args: ScopeScanArgs,
  scopePaths: readonly string[]
): Promise<AiVaultSession[]> {
  const signal = args.options.signal
  const inScope = createAiVaultScopeCwdMatcher(scopePaths)
  const candidates = walkCandidates(args, scopePaths)
  const sessions = new ScannedSessionCollection()
  for (let index = 0; index < candidates.length && sessions.size < args.limit; ) {
    throwIfAiVaultScanCancelled(signal)
    const batch = candidates.slice(index, index + SCOPE_WALK_BATCH_SIZE)
    index += batch.length
    const verdicts = await Promise.all(
      batch.map((candidate) => mayBeInScope(candidate, inScope, args.platform, signal))
    )
    throwIfAiVaultScanCancelled(signal)
    const selected = batch.filter((_, batchIndex) => verdicts[batchIndex])
    if (selected.length === 0) {
      continue
    }
    noteAiVaultScanReading(signal, selected.length)
    const results = await Promise.all(
      selected.map((candidate) =>
        // Unlisted: an out-of-scope parse must not join the parse cache's unbounded listed rows.
        parseSessionCandidate(candidate, {
          platform: args.platform,
          executionHostId: args.executionHostId,
          parseStats: args.parseStats,
          antigravityWorkspaceResolver: args.antigravityWorkspaceResolver,
          listed: false,
          signal
        })
      )
    )
    throwIfAiVaultScanCancelled(signal)
    noteAiVaultScanFilesRead(signal, selected.length)
    results.forEach((result, resultIndex) => {
      if (result.issue) {
        recordSessionScanIssue(args.issues, result.issue)
      }
      if (result.session && inScope(result.session.cwd)) {
        noteSessionParseCacheListed(selected[resultIndex].file.path)
        sessions.add(result.session)
      }
    })
  }
  return [...sessions.values()]
}

function walkCandidates(args: ScopeScanArgs, scopePaths: readonly string[]): SessionFileCandidate[] {
  const all: SessionFileCandidate[] = []
  const seenPaths = new Set<string>()
  for (const discovery of args.discoveries) {
    if (!scopeWalksAgentFiles(discovery.agent, scopePaths)) {
      continue
    }
    const files = []
    for (const file of [...discovery.files, ...(discovery.scopeFiles ?? [])]) {
      if (!seenPaths.has(file.path)) {
        seenPaths.add(file.path)
        files.push(file)
      }
    }
    all.push(...discoveryFileCandidates(discovery, files, args.options))
  }
  pruneTranscriptHeadCwdCache(seenPaths)
  // Aliases collapse with the listed files still present, so a listed rollout's
  // hardlink in another Codex home is not parsed again.
  return dropCodexHardlinkAliases(all)
    .filter((candidate) => !args.alreadyParsedFilePaths.has(candidate.file.path))
    .sort((left, right) => right.file.mtimeMs - left.file.mtimeMs)
}

/** False only when a current parse or the transcript's opening records put it out of scope. */
async function mayBeInScope(
  candidate: SessionFileCandidate,
  inScope: (cwd: string | null | undefined) => boolean,
  platform: NodeJS.Platform,
  signal: AbortSignal | undefined
): Promise<boolean> {
  const { file } = candidate
  const entry = peekSessionParseCacheEntry(file.path)
  if (
    entry !== undefined &&
    entry.platform === platform &&
    entry.mtimeMs === file.mtimeMs &&
    (entry.sizeBytes === null ||
      file.sizeBytes === undefined ||
      entry.sizeBytes === file.sizeBytes) &&
    sidecarUnchanged(entry.sidecar, file.sidecar)
  ) {
    return entry.session !== null && inScope(entry.session.cwd)
  }
  const source = AI_VAULT_SCOPE_CWD_SOURCES[candidate.agent]
  if (source.kind !== 'head') {
    return true
  }
  const cwd = await readTranscriptHeadCwd(file, source.cwdOf, signal)
  return cwd === null || inScope(cwd)
}
