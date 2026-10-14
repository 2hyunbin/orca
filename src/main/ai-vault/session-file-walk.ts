import type { Dirent } from 'node:fs'
import { opendir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { isWslUncPath } from '../../shared/wsl-paths'
import type { AiVaultAgent, AiVaultScanIssue } from '../../shared/ai-vault-types'
import { wslGatedReaddir } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'

export type SessionFileWalkOptions = {
  extensions: Set<string>
  filePredicate?: (path: string) => boolean
  // Return false to skip descending into a directory; depth 0 is a child of
  // rootDir, so pruned subtrees are never stat'd or parsed.
  directoryPredicate?: (name: string, depth: number) => boolean
  readDirectory?: (dirPath: string) => Promise<Dirent[]>
  signal?: AbortSignal
  firstMatch?: true
  strictReadErrors?: true
}

/** Collecting form for callers that want every match; bounded scans stream. */
export async function walkSessionFiles(
  dirPath: string,
  agent: AiVaultAgent,
  issues: AiVaultScanIssue[],
  options: SessionFileWalkOptions
): Promise<string[]> {
  const files: string[] = []
  await forEachSessionFile(dirPath, agent, issues, options, async (path) => {
    files.push(path)
    return options.firstMatch
  })
  return files
}

/** Streams matches to `onFile` so a bounded consumer never retains the whole tree. */
export async function forEachSessionFile(
  dirPath: string,
  agent: AiVaultAgent,
  issues: AiVaultScanIssue[],
  options: SessionFileWalkOptions,
  onFile: (path: string) => void | boolean | Promise<void | boolean>,
  depth = 0
): Promise<boolean> {
  options.signal?.throwIfAborted()
  for await (const entry of sessionDirectoryEntries(dirPath, options)) {
    options.signal?.throwIfAborted()
    const fullPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      // Skip whole subtrees an agent never wants (e.g. subagent transcripts),
      // avoiding the readdir cost of descending into them.
      if (options.directoryPredicate?.(entry.name, depth) ?? true) {
        if (await forEachSessionFile(fullPath, agent, issues, options, onFile, depth + 1)) {
          return true
        }
      }
      continue
    }
    if (
      entry.isFile() &&
      options.extensions.has(extname(entry.name).toLowerCase()) &&
      (options.filePredicate?.(fullPath) ?? true)
    ) {
      const observation = onFile(fullPath)
      if (observation && (await observation) === true) {
        return true
      }
    }
  }
  return false
}

async function* sessionDirectoryEntries(dirPath: string, options: SessionFileWalkOptions) {
  try {
    if (options.firstMatch && !options.readDirectory && !isWslUncPath(dirPath)) {
      yield* await opendir(dirPath)
    } else {
      yield* options.readDirectory
        ? await options.readDirectory(dirPath)
        : await wslGatedReaddir(dirPath, 'scan', options.signal)
    }
  } catch (error) {
    options.signal?.throwIfAborted()
    const missing =
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    if (error instanceof WslTranscriptFsError || (options.strictReadErrors && !missing)) {
      throw error
    }
  }
}
