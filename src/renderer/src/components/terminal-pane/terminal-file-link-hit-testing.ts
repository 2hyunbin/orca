import { dedupeLogicalLines } from './terminal-link-logical-line-deduplication'
import type { IBufferLine, IBufferRange } from '@xterm/xterm'
import { extractTerminalFileLinkCandidates } from '@/lib/terminal-links'
import {
  reserveDetectedFilePathOpenTurn,
  openDetectedFilePath,
  type FileOpenFailure
} from './terminal-file-open-routing'
import {
  fileLinkTargetExists,
  resolveFileLinkTarget,
  type FileLinkTarget
} from './terminal-file-link-target'
import { createTerminalPathExistenceBatch } from './terminal-path-existence-batch'
import { writeTerminalPathExistsCache } from './terminal-path-exists-cache'
import {
  buildHardWrappedPathLogicalLineCandidates,
  buildWrappedLogicalLine,
  rangeForParsedFileLink,
  type WrappedLogicalLine
} from './wrapped-terminal-link-ranges'

type FileLinkHitTestDeps = {
  startupCwd: string
  terminalHomePath?: string | null
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId?: string | null
  wslDistro?: string | null
  terminalHandle?: string | null
  pathExistsCache?: Map<string, boolean>
  openWithSystemDefault?: boolean
  sourceTabId?: string | null
  /** Tells the user why a click opened nothing; skipped once a later click supersedes it. */
  onOpenFailure?: (absolutePath: string, failure: FileOpenFailure) => void
}

type ClickedFileLink = FileLinkTarget & {
  pathText: string
  cachedExists: boolean | undefined
}

// Why: a slow probe from an earlier click must not open its file after a later click.
let latestClickGesture = 0

export function openFilePathLinkAtBufferPosition(
  buffer: { getLine(y: number): IBufferLine | undefined },
  position: { x: number; y: number },
  terminalColumns: number,
  deps: FileLinkHitTestDeps
): boolean {
  const gesture = ++latestClickGesture
  const links: ClickedFileLink[] = []
  for (const logicalLine of buildCandidateLogicalLinesForBufferPosition(buffer, position.y)) {
    for (const parsed of extractTerminalFileLinkCandidates(logicalLine.text)) {
      const target = resolveFileLinkTarget(parsed, {
        cwd: deps.startupCwd,
        homePath: deps.terminalHomePath,
        worktreeId: deps.worktreeId,
        worktreePath: deps.worktreePath,
        runtimeEnvironmentId: deps.runtimeEnvironmentId,
        wslDistro: deps.wslDistro
      })
      if (!target) {
        continue
      }
      const range = rangeForParsedFileLink(logicalLine, parsed.startIndex, parsed.endIndex)
      if (!range || !rangeContainsBufferPosition(range, position, terminalColumns)) {
        continue
      }
      links.push({
        ...target,
        pathText: parsed.pathText,
        cachedExists: deps.pathExistsCache?.get(target.cacheKey)
      })
    }
  }

  const open = (link: ClickedFileLink, verified = link.cachedExists === true): void => {
    const { onOpenFailure } = deps
    // Why: a bare dotted word (`console.log`, `example.com`) is not a claim that a file exists.
    const reportsFailure =
      onOpenFailure && (verified || link.isKnownWorktreeRoot || /[\\/]/.test(link.pathText))
    openDetectedFilePath(link.absolutePath, link.line, link.column, {
      ...deps,
      openWithSystemDefault: deps.openWithSystemDefault === true,
      onOpenFailure: reportsFailure
        ? (failure) => onOpenFailure(link.absolutePath, failure)
        : undefined
    })
  }
  const known = longestPath(
    links.filter((link) => link.cachedExists === true || link.isKnownWorktreeRoot)
  )
  // Why longer only: a cached `foo.ts` must not win over an unchecked hard-wrapped `foo.ts.map`.
  const unprobed = links.filter(
    (link, index) =>
      link.cachedExists === undefined &&
      !link.isKnownWorktreeRoot &&
      (!known || link.pathText.length > known.pathText.length) &&
      links.findIndex((other) => other.cacheKey === link.cacheKey) === index
  )
  const unanswerable = deps.pathExistsCache && unanswerableProbes.get(deps.pathExistsCache)
  const toProbe = unprobed.filter((link) => !unanswerable?.has(link.cacheKey))
  // Why the shortest: it is the path the user sees, and opening it lets the open report the
  // real failure instead of a probe guessing "missing" for a refusal.
  const fallback =
    known ??
    unprobed.reduce<ClickedFileLink | undefined>(
      (a, b) => (!a || b.pathText.length < a.pathText.length ? b : a),
      undefined
    )
  if (toProbe.length === 0 || (!known && toProbe.length === 1)) {
    const link = known ?? toProbe[0] ?? fallback
    if (link) {
      open(link)
    }
    return link !== undefined
  }

  // Why: hard-wrap joining offers guesses like `a.txt/b.txt` that sort first; opening one
  // before its hover probe answers (a host round-trip) fails and hides the real path.
  const isLatestOpen = reserveDetectedFilePathOpenTurn()
  void probeClickedFileLinks(toProbe, deps).then((existing) => {
    if (gesture !== latestClickGesture || !isLatestOpen()) {
      return
    }
    const found = longestPath(existing)
    if (found) {
      open(found, true)
    } else if (fallback) {
      open(fallback)
    }
  })
  return true
}

// Why: older hosts reject `a.txt/b.txt` with ENOTDIR instead of answering, so remember which
// guesses a reachable host could not answer rather than re-asking on every click.
const unanswerableProbes = new WeakMap<Map<string, boolean>, Map<string, true>>()

async function probeClickedFileLinks(
  links: ClickedFileLink[],
  deps: FileLinkHitTestDeps
): Promise<ClickedFileLink[]> {
  const pathExists = createTerminalPathExistenceBatch()
  const cache = deps.pathExistsCache ?? new Map<string, boolean>()
  const exists = await Promise.all(
    links.map((link) =>
      // Why: a guess the host cannot answer must not hide a sibling.
      fileLinkTargetExists(link, cache, pathExists, deps.terminalHandle).catch(() => undefined)
    )
  )
  // Why only when a sibling was answered: an unreachable host says nothing about any path.
  if (deps.pathExistsCache && exists.some((answer) => answer !== undefined)) {
    const unanswerable = unanswerableProbes.get(deps.pathExistsCache) ?? new Map<string, true>()
    unanswerableProbes.set(deps.pathExistsCache, unanswerable)
    links.forEach((link, index) => {
      if (exists[index] === undefined) {
        writeTerminalPathExistsCache(unanswerable, link.cacheKey, true)
      }
    })
  }
  return links.filter((_, index) => exists[index] === true)
}

function longestPath(links: ClickedFileLink[]): ClickedFileLink | undefined {
  return links.reduce<ClickedFileLink | undefined>(
    (best, link) => (!best || link.pathText.length > best.pathText.length ? link : best),
    undefined
  )
}

export function buildCandidateLogicalLinesForBufferPosition(
  buffer: { getLine(y: number): IBufferLine | undefined },
  bufferLineNumber: number
): WrappedLogicalLine[] {
  const hardWrappedCandidates = buildHardWrappedPathLogicalLineCandidates(buffer, bufferLineNumber)
  const softWrappedLogicalLine = buildWrappedLogicalLine(buffer, bufferLineNumber)
  const candidates = softWrappedLogicalLine
    ? [...hardWrappedCandidates, softWrappedLogicalLine]
    : hardWrappedCandidates
  return dedupeLogicalLines(candidates)
}

function rangeContainsBufferPosition(
  range: IBufferRange,
  position: { x: number; y: number },
  terminalColumns: number
): boolean {
  const lower = range.start.y * terminalColumns + range.start.x
  const upper = range.end.y * terminalColumns + range.end.x
  const current = position.y * terminalColumns + position.x
  return lower <= current && current <= upper
}
