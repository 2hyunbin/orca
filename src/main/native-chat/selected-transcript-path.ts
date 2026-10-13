import { opendir, stat } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { throwIfSignalAborted } from '../../shared/abort-signal-reason'
import { encodeClaudeProjectPaths } from '../ai-vault/claude-project-dir-encoding'
import { SESSION_FILE_ID_LAYOUTS } from './session-file-id-layouts'

export type SelectedTranscriptLookup = {
  transcriptPath?: string
  cwd: string
  signal?: AbortSignal
  budget: { directories: number; entries: number }
}

function missing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

async function fileExists(path: string, signal?: AbortSignal): Promise<boolean> {
  throwIfSignalAborted(signal)
  try {
    const info = await stat(path)
    throwIfSignalAborted(signal)
    return info.isFile()
  } catch (error) {
    if (missing(error)) {
      return false
    }
    throw error
  }
}

export async function findSelectedTranscriptPath(
  agent: 'claude' | 'codex',
  sessionId: string,
  accountHome: string,
  selected: SelectedTranscriptLookup
): Promise<string | null> {
  const root = join(accountHome, agent === 'claude' ? 'projects' : 'sessions')
  const path = selected.transcriptPath
  if (path) {
    const within = relative(root, path)
    if (
      within &&
      !within.startsWith('..') &&
      !isAbsolute(within) &&
      (await fileExists(path, selected.signal))
    ) {
      return path
    }
  }
  if (agent === 'claude') {
    for (const bucket of encodeClaudeProjectPaths(selected.cwd)) {
      const candidate = join(root, bucket, `${sessionId}.jsonl`)
      if (await fileExists(candidate, selected.signal)) {
        return candidate
      }
    }
  }
  // Only candidate names are examined; no unrelated transcript content is read.
  const pending = [{ path: root, depth: 0 }]
  while (pending.length) {
    throwIfSignalAborted(selected.signal)
    const directory = pending.pop()
    if (!directory) {
      break
    }
    if (++selected.budget.directories > 64) {
      throw new Error('Conversation lookup exceeded its directory limit.')
    }
    try {
      for await (const entry of await opendir(directory.path)) {
        throwIfSignalAborted(selected.signal)
        if (++selected.budget.entries > 4096) {
          throw new Error('Conversation lookup exceeded its entry limit.')
        }
        const candidate = join(directory.path, entry.name)
        if (entry.isFile() && SESSION_FILE_ID_LAYOUTS[agent].fileMatchesId(candidate, sessionId)) {
          return candidate
        }
        const allowed =
          agent === 'claude'
            ? directory.depth === 0
            : directory.depth < 3 && /^\d{2,4}$/.test(entry.name)
        if (entry.isDirectory() && allowed) {
          pending.push({ path: candidate, depth: directory.depth + 1 })
        }
      }
    } catch (error) {
      if (!missing(error)) {
        throw error
      }
    }
  }
  return null
}
