import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { throwIfSignalAborted } from '../../shared/abort-signal-reason'
import { encodeClaudeProjectPaths } from '../ai-vault/claude-project-dir-encoding'
import { admitTranscriptPath } from './transcript-path-admission'
import { resolveSessionFilePath } from './session-file-resolver'

export type SelectedTranscriptLookup = {
  transcriptPath?: string
  cwd: string
  signal?: AbortSignal
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
  const exact = await findSelectedTranscriptFile(root, selected)
  if (exact) {
    return exact
  }
  if (agent === 'claude') {
    for (const bucket of encodeClaudeProjectPaths(selected.cwd)) {
      const candidate = join(root, bucket, `${sessionId}.jsonl`)
      if (await fileExists(candidate, selected.signal)) {
        return candidate
      }
    }
  }
  return resolveSessionFilePath(
    agent,
    sessionId,
    {
      ...(agent === 'claude' ? { claudeProjectsDir: root } : { codexSessionsDirs: [root] }),
      selectedLookup: true
    },
    selected.signal
  )
}

export async function findSelectedTranscriptFile(
  root: string,
  selected: SelectedTranscriptLookup
): Promise<string | null> {
  if (!selected.transcriptPath) {
    return null
  }
  const admitted = await admitTranscriptPath(root, selected.transcriptPath)
  throwIfSignalAborted(selected.signal)
  if (!admitted) {
    throw new Error('The conversation path is outside its account.')
  }
  return (await fileExists(admitted.path, selected.signal)) ? admitted.path : null
}
