import { extname, join } from 'node:path'
import { wslGatedReaddir, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import type { CwdBucketLayout } from './session-cwd-bucket-layouts'
import type { AiVaultAgent, AiVaultScanIssue } from '../../shared/ai-vault-types'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { recordSessionScanIssue } from './session-scan-issues'
import type { FileWithMtime } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import {
  cachedProjectDirCwd,
  readFirstCwd,
  recordRefusal,
  TRANSCRIPT_EXTENSIONS
} from './session-scanner-project-dir-cwd'

type InScopeDiscoveryArgs = {
  rootDirs: readonly string[]
  scopePaths: readonly string[]
  limit: number
  excludedFilePaths: ReadonlySet<string>
  issues: AiVaultScanIssue[]
  signal?: AbortSignal
}

/**
 * Fully include the transcripts of cwd-bucket directories (Claude, Pi, CodeBuddy) whose cwd
 * falls inside the active workspace/project paths.
 *
 * Why: these agents keep one directory per cwd, e.g. `~/.claude/projects/<cwd-encoded>/`.
 * The global scan is recency-capped, so a project the user hasn't touched recently
 * can drop off the list entirely even though the agent's own resume still finds it.
 * For scoped panel views we resolve each bucket's cwd cheaply and bypass the cap for
 * the ones that belong to the active scope.
 */
export async function discoverInScopeCwdBucketFiles(
  layout: CwdBucketLayout,
  args: InScopeDiscoveryArgs
): Promise<FileWithMtime[]> {
  if (args.scopePaths.length === 0 || args.limit <= 0) {
    return []
  }
  const scopeProjectPrefixes = cwdBucketScopePrefixes(layout, args.scopePaths)
  const collected = new Map<string, FileWithMtime>()
  for (const rootDir of args.rootDirs) {
    for (const projectDir of await listProjectDirs(
      layout,
      rootDir,
      scopeProjectPrefixes,
      args.issues,
      args.signal
    )) {
      throwIfAiVaultScanCancelled(args.signal)
      if (layout.agent === 'claude') {
        const cwd = await cachedProjectDirCwd(projectDir, args.issues, layout.agent, args.signal)
        if (!cwd || !args.scopePaths.some((scopePath) => isCwdInsideScopePath(scopePath, cwd))) {
          continue
        }
      }
      await collectBucketFiles({
        agent: layout.agent,
        scopePaths: layout.agent !== 'claude' ? args.scopePaths : undefined,
        projectDir,
        issues: args.issues,
        collected,
        limit: args.limit,
        excludedFilePaths: args.excludedFilePaths,
        signal: args.signal
      })
    }
  }
  return [...collected.values()].sort((left, right) => right.mtimeMs - left.mtimeMs)
}

function cwdBucketScopePrefixes(
  layout: CwdBucketLayout,
  scopePaths: readonly string[]
): Set<string> {
  const prefixes = new Set<string>()
  for (const scopePath of scopePaths) {
    for (const candidate of scopePathCandidates(scopePath)) {
      for (const prefix of layout.encodeScopePrefixes(candidate)) {
        prefixes.add(prefix)
      }
    }
  }
  return prefixes
}

function scopePathCandidates(scopePath: string): string[] {
  const wslScopePath = parseWslUncPath(scopePath)
  return wslScopePath ? [scopePath, wslScopePath.linuxPath] : [scopePath]
}

function isCwdInsideScopePath(scopePath: string, cwd: string): boolean {
  if (isPathInsideOrEqual(scopePath, cwd)) {
    return true
  }

  const wslScopePath = parseWslUncPath(scopePath)
  if (!wslScopePath) {
    return false
  }

  // WSL transcripts record Linux cwd values even when the renderer sends the
  // active worktree as a Windows UNC path.
  return isPathInsideOrEqual(wslScopePath.linuxPath, cwd)
}

async function listProjectDirs(
  layout: CwdBucketLayout,
  rootDir: string,
  scopeProjectPrefixes: ReadonlySet<string>,
  issues: AiVaultScanIssue[],
  signal: AbortSignal | undefined
): Promise<string[]> {
  let entries
  try {
    entries = await wslGatedReaddir(rootDir, 'scan', signal)
  } catch (err) {
    recordRefusal(issues, rootDir, err, layout.agent, signal)
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && layout.isDirInScope(entry.name, scopeProjectPrefixes))
    .map((entry) => join(rootDir, entry.name))
}

async function collectBucketFiles(args: {
  agent: AiVaultAgent
  scopePaths?: readonly string[]
  projectDir: string
  issues: AiVaultScanIssue[]
  collected: Map<string, FileWithMtime>
  limit: number
  excludedFilePaths: ReadonlySet<string>
  signal: AbortSignal | undefined
}): Promise<void> {
  let entries
  try {
    entries = await wslGatedReaddir(args.projectDir, 'scan', args.signal)
  } catch (err) {
    recordRefusal(args.issues, args.projectDir, err, args.agent, args.signal)
    return
  }
  for (const entry of entries) {
    throwIfAiVaultScanCancelled(args.signal)
    if (!entry.isFile() || !TRANSCRIPT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      continue
    }
    const path = join(args.projectDir, entry.name)
    if (args.collected.has(path) || args.excludedFilePaths.has(path)) {
      continue
    }
    try {
      if (args.scopePaths) {
        const cwd = await readFirstCwd(path, args.issues, args.agent, args.signal)
        if (!cwd || !args.scopePaths.some((scope) => isCwdInsideScopePath(scope, cwd))) {
          continue
        }
      }
      const fileStat = await wslGatedStat(path, 'scan', args.signal)
      addBoundedFile(args.collected, args.limit, {
        path,
        mtimeMs: fileStat.mtimeMs,
        modifiedAt: fileStat.mtime.toISOString(),
        sizeBytes: fileStat.size
      })
    } catch (err) {
      throwIfAiVaultScanCancelled(args.signal)
      recordSessionScanIssue(args.issues, { agent: args.agent, path, message: errorMessage(err) })
    }
  }
}

function addBoundedFile(
  collected: Map<string, FileWithMtime>,
  limit: number,
  file: FileWithMtime
): void {
  if (collected.size < limit) {
    collected.set(file.path, file)
    return
  }

  let oldest: FileWithMtime | null = null
  for (const candidate of collected.values()) {
    if (!oldest || candidate.mtimeMs < oldest.mtimeMs) {
      oldest = candidate
    }
  }
  if (oldest && file.mtimeMs > oldest.mtimeMs) {
    collected.delete(oldest.path)
    collected.set(file.path, file)
  }
}
