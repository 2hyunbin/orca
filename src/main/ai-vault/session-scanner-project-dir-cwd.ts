import { createInterface } from 'node:readline'
import { extname, join } from 'node:path'
import {
  openTranscriptReadStream,
  wslGatedReaddir,
  wslGatedStat
} from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import type { AiVaultAgent, AiVaultScanIssue } from '../../shared/ai-vault-types'
import { recordSessionScanIssue } from './session-scan-issues'
import { extractString, parseJsonObject } from './session-scanner-values'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'

// The cwd a cwd-bucket directory (Claude, Pi, CodeBuddy) belongs to, read from its newest transcripts.

// Reading a few lines of one transcript per project dir is enough to learn that
// dir's cwd; cap both so a giant or cwd-less transcript can't stall the scan.
const REPRESENTATIVE_CWD_LINE_LIMIT = 200
const REPRESENTATIVE_FILE_LIMIT = 3
export const TRANSCRIPT_EXTENSIONS = new Set(['.jsonl'])

// Bucket encodings are lossy; retain Claude’s cache and verify other transcripts individually.
const PROJECT_DIR_CWD_CACHE_MAX = 2048
const projectDirCwdCache = new Map<string, string>()

export function resetProjectDirCwdCacheForTests(): void {
  projectDirCwdCache.clear()
}

// A gate refusal is a stalled WSL root, not an empty one: keep the existing
// degrade-to-empty containment but make the gap visible in the scan issues.
export function recordRefusal(
  issues: AiVaultScanIssue[],
  path: string,
  error: unknown,
  agent: AiVaultAgent,
  signal: AbortSignal | undefined
): void {
  // A cancelled scan is not an empty or unreadable directory.
  throwIfAiVaultScanCancelled(signal)
  if (error instanceof WslTranscriptFsError) {
    recordSessionScanIssue(issues, { agent, path, message: error.message })
  }
}

export async function cachedProjectDirCwd(
  projectDir: string,
  issues: AiVaultScanIssue[],
  agent: AiVaultAgent,
  signal: AbortSignal | undefined
): Promise<string | null> {
  const cached = projectDirCwdCache.get(projectDir)
  if (cached !== undefined) {
    // Refresh recency so hot in-scope dirs outlive one-off ones at the cap.
    projectDirCwdCache.delete(projectDir)
    projectDirCwdCache.set(projectDir, cached)
    return cached
  }
  const cwd = await readProjectDirCwd(projectDir, issues, agent, signal)
  if (cwd) {
    if (projectDirCwdCache.size >= PROJECT_DIR_CWD_CACHE_MAX) {
      const oldest = projectDirCwdCache.keys().next()
      if (!oldest.done) {
        projectDirCwdCache.delete(oldest.value)
      }
    }
    projectDirCwdCache.set(projectDir, cwd)
  }
  return cwd
}

async function readProjectDirCwd(
  projectDir: string,
  issues: AiVaultScanIssue[],
  agent: AiVaultAgent,
  signal: AbortSignal | undefined
): Promise<string | null> {
  const files = await newestTranscriptsInDir(projectDir, issues, agent, signal)
  for (const file of files.slice(0, REPRESENTATIVE_FILE_LIMIT)) {
    const cwd = await readFirstCwd(file, issues, agent, signal)
    if (cwd) {
      return cwd
    }
  }
  return null
}

async function newestTranscriptsInDir(
  projectDir: string,
  issues: AiVaultScanIssue[],
  agent: AiVaultAgent,
  signal: AbortSignal | undefined
): Promise<string[]> {
  let entries
  try {
    entries = await wslGatedReaddir(projectDir, 'scan', signal)
  } catch (err) {
    recordRefusal(issues, projectDir, err, agent, signal)
    return []
  }
  const newest: { path: string; mtimeMs: number }[] = []
  for (const entry of entries) {
    throwIfAiVaultScanCancelled(signal)
    if (!entry.isFile() || !TRANSCRIPT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      continue
    }
    const path = join(projectDir, entry.name)
    try {
      addBoundedPath(newest, REPRESENTATIVE_FILE_LIMIT, {
        path,
        mtimeMs: (await wslGatedStat(path, 'scan', signal)).mtimeMs
      })
    } catch (err) {
      // Best effort: unreadable candidates are ignored here and reported during
      // full collection if the project directory proves in-scope.
      recordRefusal(issues, path, err, agent, signal)
    }
  }
  return newest.sort((left, right) => right.mtimeMs - left.mtimeMs).map((value) => value.path)
}

export async function readFirstCwd(
  filePath: string,
  issues: AiVaultScanIssue[],
  agent: AiVaultAgent,
  signal: AbortSignal | undefined
): Promise<string | null> {
  const input = openTranscriptReadStream(filePath, { encoding: 'utf-8' }, 'scan', signal)
  const lines = createInterface({ input, crlfDelay: Infinity })
  let read = 0
  try {
    for await (const line of lines) {
      if (read++ >= REPRESENTATIVE_CWD_LINE_LIMIT) {
        break
      }
      const cwd = extractString(parseJsonObject(line)?.cwd)
      if (cwd) {
        return cwd
      }
    }
  } catch (err) {
    recordRefusal(issues, filePath, err, agent, signal)
    return null
  } finally {
    // readline.close() leaves the underlying stream open; destroy it so the early
    // break/catch paths don't leak a file descriptor (this runs per project dir).
    lines.close()
    input.destroy()
  }
  return null
}

function addBoundedPath<T extends { mtimeMs: number }>(items: T[], limit: number, item: T): void {
  if (items.length < limit) {
    items.push(item)
    return
  }

  let oldestIndex = 0
  for (let index = 1; index < items.length; index++) {
    if (items[index].mtimeMs < items[oldestIndex].mtimeMs) {
      oldestIndex = index
    }
  }
  if (item.mtimeMs > items[oldestIndex].mtimeMs) {
    items[oldestIndex] = item
  }
}
