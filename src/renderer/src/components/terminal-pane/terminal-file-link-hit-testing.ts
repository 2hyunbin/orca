import { dedupeLogicalLines } from './terminal-link-logical-line-deduplication'
import type { IBufferLine, IBufferRange } from '@xterm/xterm'
import { extractTerminalFileLinkCandidates } from '@/lib/terminal-links'
import { openDetectedFilePath, type FileOpenFailure } from './terminal-file-open-routing'
import {
  fileLinkTargetExists,
  resolveFileLinkTarget,
  type FileLinkTarget
} from './terminal-file-link-target'
import { createTerminalPathExistenceBatch } from './terminal-path-existence-batch'
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

  const open = (link: ClickedFileLink): void => {
    const { onOpenFailure } = deps
    // Why: a bare dotted word (`console.log`, `example.com`) is not a claim that a file exists.
    const reportsFailure =
      onOpenFailure &&
      (link.cachedExists === true || link.isKnownWorktreeRoot || /[\\/]/.test(link.pathText))
    openDetectedFilePath(link.absolutePath, link.line, link.column, {
      ...deps,
      openWithSystemDefault: deps.openWithSystemDefault === true,
      onOpenFailure: reportsFailure
        ? (failure) => onOpenFailure(link.absolutePath, failure)
        : undefined
    })
  }
  const known =
    longestPath(links.filter((link) => link.cachedExists)) ??
    longestPath(links.filter((link) => link.isKnownWorktreeRoot))
  if (known) {
    open(known)
    return true
  }

  const unprobed = links.filter(
    (link, index) =>
      link.cachedExists === undefined &&
      links.findIndex((other) => other.cacheKey === link.cacheKey) === index
  )
  if (unprobed.length <= 1) {
    if (unprobed[0]) {
      open(unprobed[0])
    }
    return unprobed.length === 1
  }

  // Why: hard-wrap joining offers guesses like `a.txt/b.txt` that sort first; opening one
  // before its hover probe answers (a host round-trip) fails and hides the real path.
  void probeClickedFileLinks(unprobed, deps).then((existing) => {
    if (gesture !== latestClickGesture) {
      return
    }
    // Why the shortest otherwise: it is the path the user sees, and opening it lets the open
    // report the real failure instead of this probe guessing "missing" for a refusal.
    open(
      longestPath(existing) ??
        unprobed.reduce((a, b) => (b.pathText.length < a.pathText.length ? b : a))
    )
  })
  return true
}

async function probeClickedFileLinks(
  links: ClickedFileLink[],
  deps: FileLinkHitTestDeps
): Promise<ClickedFileLink[]> {
  const pathExists = createTerminalPathExistenceBatch()
  const cache = deps.pathExistsCache ?? new Map<string, boolean>()
  const exists = await Promise.all(
    links.map((link) =>
      // Why: a guess the host cannot answer (older hosts reject ENOTDIR) must not hide a sibling.
      fileLinkTargetExists(link, cache, pathExists, deps.terminalHandle).catch(() => false)
    )
  )
  return links.filter((_, index) => exists[index])
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
