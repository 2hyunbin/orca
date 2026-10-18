import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { listTrackedFiles, readTrackedSources, runEntryRatchet } from './ratchet-baseline.mjs'

// Ratchet on `src/...` path literals in CI config, workflows and e2e code that name nothing. A
// moved or deleted file silently orphans these hand-kept references (routes, gate manifests,
// workflow `paths:`), so the check runs ahead of folder moves. Known-stale entries may only shrink.

const BASELINE_PATH = 'config/path-literal-baseline.txt'
const SCAN_ROOTS = ['config', '.github', 'tests']
const SOURCE_ROOTS = 'main|renderer|shared|cli|preload|wsl-guest'
const RESOLVED_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '/index.ts']
// Generated timings; a stale row only skews shard balance and is rewritten by its generator.
const EXCLUDED_FILES = new Set(['config/scripts/ci-shard-timings.json'])
// Command strings in manifests and scripts name paths unquoted; in code only quoted literals count,
// so prose in comments is not scanned.
const UNQUOTED_ALLOWED = /\.(?:jsonc?|ya?ml|sh|ps1)$/
// Group 1 is a relative import's `../` chain: imports must resolve exactly, not as a prefix.
const QUOTED_LITERAL = new RegExp(
  `(?:['"\`]|:\\(glob\\))((?:\\.\\.\\/)*)(src\\/(?:${SOURCE_ROOTS})\\/[\\w@\\-./]*)`,
  'g'
)
const ANY_LITERAL = new RegExp(
  `(?:['"\`\\s=]|:\\(glob\\)|^)((?:\\.\\.\\/)*)(src\\/(?:${SOURCE_ROOTS})\\/[\\w@\\-./]*)`,
  'gm'
)

export function isScannedPath(rel) {
  return (
    /\.(?:m?js|cjs|ts|jsonc?|ya?ml|ps1|sh)$/.test(rel) &&
    !EXCLUDED_FILES.has(rel) &&
    // Unit tests and fixtures name fake paths on purpose; e2e specs import real ones.
    (/^tests\/e2e\/.*\.spec\.ts$/.test(rel) || !/\.(?:test|spec)\.|fixture|benchmark/.test(rel))
  )
}

/**
 * Every `src/...` literal in one file, with a trailing glob or sentence period cut off. Relative
 * imports are marked so they resolve exactly.
 */
export function extractPathLiterals(rel, text) {
  const pattern = UNQUOTED_ALLOWED.test(rel) ? ANY_LITERAL : QUOTED_LITERAL
  const literals = new Map()
  for (const [, parents, literal] of text.matchAll(pattern)) {
    const key = literal.replace(/\.+$/, '')
    literals.set(key, (literals.get(key) ?? true) && parents.length > 0)
  }
  return [...literals].map(([literal, isImport]) => ({ literal, isImport }))
}

/** A literal resolves when it names a file or folder, a module without extension, or (unless it
 * is an import) a prefix of a tracked file. */
export function createPathResolver(root, trackedFiles) {
  const sorted = [...trackedFiles].sort()
  const hasPrefix = (prefix) => {
    let low = 0
    let high = sorted.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (sorted[mid] < prefix) {
        low = mid + 1
      } else {
        high = mid
      }
    }
    return low < sorted.length && sorted[low].startsWith(prefix)
  }
  return (literal, isImport = false) =>
    (!isImport && hasPrefix(literal)) ||
    fs.existsSync(path.join(root, literal)) ||
    RESOLVED_EXTENSIONS.some((extension) => fs.existsSync(path.join(root, literal + extension)))
}

export function collectUnresolvedPathLiterals(root = process.cwd()) {
  const resolves = createPathResolver(root, listTrackedFiles(root, ['src']))
  const entries = []
  for (const [rel, text] of readTrackedSources(root, SCAN_ROOTS, isScannedPath)) {
    for (const { literal, isImport } of extractPathLiterals(rel, text)) {
      if (!resolves(literal, isImport)) {
        entries.push(`${rel} ${literal}`)
      }
    }
  }
  return entries.sort()
}

const RATCHET = {
  name: 'path-literal',
  baselinePath: BASELINE_PATH,
  header: [
    '# `<file> <src/... literal>` pairs in config/, .github/ and tests/ that name no tracked file.',
    '# This is a RATCHET: the list may only SHRINK. Fix the reference, then prune:',
    '# pnpm check:path-literal-ratchet --prune'
  ],
  collect: collectUnresolvedPathLiterals,
  fix: [
    'A src/... path in CI config, a workflow or an e2e file names no tracked file. Update it to the',
    "file's new path (a move or rename orphaned it), or drop it if the file is gone."
  ]
}

export function main(root = process.cwd(), arg = undefined) {
  return runEntryRatchet(RATCHET, root, arg)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
