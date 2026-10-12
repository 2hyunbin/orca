import { forceRepaintThroughRenderPause } from './terminal-render-pause-release'
import {
  disposeParsedDirtyRows,
  readParsedDirtyRowSpan,
  resetParsedDirtyRows,
  type ParsedDirtyRowSpan
} from './terminal-parsed-dirty-rows'
import { runGuardedWriteCompletionStep } from './xterm-write-callback-guard'

export type ForegroundTerminalOutputTarget = {
  buffer?: {
    active?: {
      type?: string
      cursorY?: number
      baseY?: number
      viewportY?: number
    }
  }
  rows?: number
  cols?: number
  _core?: {
    refresh?(start: number, end: number, sync?: boolean): void
  }
  refresh?(start: number, end: number): void
  write(data: string, callback?: () => void): void
}

type ForegroundTerminalWriteOptions = {
  forceViewportRefresh?: boolean
  followupViewportRefresh?: boolean
  shouldRefreshViewportSynchronously?: () => boolean
  shouldReleaseRenderPause?: () => boolean
  onParsed?: () => void
  onWriteFailure?: () => void
}

type PendingViewportSettleRefresh = {
  /** The rows the repeat repaints, or `null` for the whole viewport. */
  span: ParsedDirtyRowSpan | null
  /** Geometry `span` addresses; the repeat goes whole-grid if it moved. */
  viewport: ViewportSnapshot
  cancel: () => void
}

const pendingViewportSettleRefreshByTerminal = new WeakMap<
  ForegroundTerminalOutputTarget,
  PendingViewportSettleRefresh
>()

type ViewportSnapshot = {
  type: string | null
  cursorY: number | null
  baseY: number | null
  viewportY: number | null
  rows: number | null
  cols: number | null
}

function refreshVisibleRows(
  terminal: ForegroundTerminalOutputTarget,
  synchronously: boolean,
  shouldReleaseRenderPause?: () => boolean,
  span?: ParsedDirtyRowSpan | null
): void {
  if (typeof terminal.rows !== 'number' || terminal.rows < 1) {
    return
  }

  try {
    // Why: only reveal-owned replay may override xterm's paused observer state;
    // ordinary or newly-hidden output must leave background rendering paused.
    if (shouldReleaseRenderPause?.() === true && forceRepaintThroughRenderPause(terminal)) {
      return
    }
    const lastRow = Math.max(0, terminal.rows - 1)
    // Why not always the whole grid: xterm's render debouncer unions ranges, so a
    // 0..rows-1 repair request turns every frame into a full-viewport cell walk.
    // `span` is the parse's own dirty rows; `null` keeps the whole-grid repaint.
    const start = span ? Math.min(Math.max(span.start, 0), lastRow) : 0
    const end = span ? Math.min(Math.max(span.end, start), lastRow) : lastRow
    // Why: DOM-rendered Windows ConPTY rewrites need an immediate repair, while
    // WebGL can merge this request into xterm's already-queued frame.
    if (synchronously && typeof terminal._core?.refresh === 'function') {
      terminal._core.refresh(start, end, true)
      return
    }
    if (typeof terminal.refresh === 'function') {
      terminal.refresh(start, end)
      return
    }
    terminal._core?.refresh?.(start, end, false)
  } catch {
    // Ignore disposed terminals; PTY output can race pane teardown.
  }
}

function captureViewportSnapshot(terminal: ForegroundTerminalOutputTarget): ViewportSnapshot {
  const active = terminal.buffer?.active
  return {
    type: typeof active?.type === 'string' ? active.type : null,
    cursorY: typeof active?.cursorY === 'number' ? active.cursorY : null,
    baseY: typeof active?.baseY === 'number' ? active.baseY : null,
    viewportY: typeof active?.viewportY === 'number' ? active.viewportY : null,
    rows: typeof terminal.rows === 'number' ? terminal.rows : null,
    cols: typeof terminal.cols === 'number' ? terminal.cols : null
  }
}

/** A scroll or resize between the snapshots: the same row number now shows another line. */
function viewportMoved(earlier: ViewportSnapshot, later: ViewportSnapshot): boolean {
  return (
    (later.baseY !== null &&
      later.viewportY !== null &&
      (later.baseY !== earlier.baseY || later.viewportY !== earlier.viewportY)) ||
    later.rows !== earlier.rows ||
    // Why cols: a column-only resize reflows wrapped lines without moving rows or origin.
    later.cols !== earlier.cols
  )
}

function sameRowGeometry(earlier: ViewportSnapshot, later: ViewportSnapshot): boolean {
  return earlier.type === later.type && !viewportMoved(earlier, later)
}

function unionRowSpans(left: ParsedDirtyRowSpan, right: ParsedDirtyRowSpan): ParsedDirtyRowSpan {
  return { start: Math.min(left.start, right.start), end: Math.max(left.end, right.end) }
}

/**
 * The rows this write's repair must cover: the parse's own dirty span widened by
 * the cursor rows on both sides of the write.
 *
 * Why the cursor rows: xterm's WebGL model drops its cursor whenever an update
 * pass excludes the cursor row, so a repair that skips it would blank the caret.
 * Returns `null` — repaint everything — whenever the span is unknown, the
 * viewport scrolled or resized (dirty rows were recorded against the old rows),
 * the write flipped between the normal and alternate buffer, or the pane is
 * scrolled into scrollback (`cursorY` counts from the live screen, not the view).
 */
function repairRowSpan(
  terminal: ForegroundTerminalOutputTarget,
  beforeWrite: ViewportSnapshot,
  afterWrite: ViewportSnapshot
): ParsedDirtyRowSpan | null {
  if (!sameRowGeometry(beforeWrite, afterWrite) || afterWrite.viewportY !== afterWrite.baseY) {
    return null
  }
  const parsed = readParsedDirtyRowSpan(terminal)
  if (!parsed) {
    return null
  }
  let { start, end } = parsed
  for (const cursorY of [beforeWrite.cursorY, afterWrite.cursorY]) {
    if (cursorY === null) {
      return null
    }
    start = Math.min(start, cursorY)
    end = Math.max(end, cursorY)
  }
  return { start, end }
}

/**
 * The queued repeat re-covers the immediate repair's rows plus the caret now.
 * Rows that later writes parse need no repeat: xterm requests those itself.
 */
function repeatRowSpan(
  terminal: ForegroundTerminalOutputTarget,
  span: ParsedDirtyRowSpan | null,
  viewport: ViewportSnapshot
): ParsedDirtyRowSpan | null {
  const current = captureViewportSnapshot(terminal)
  if (!span || current.cursorY === null || !sameRowGeometry(viewport, current)) {
    return null
  }
  return unionRowSpans(span, { start: current.cursorY, end: current.cursorY })
}

/** A superseded repeat's rows are still owed, and a whole-grid one stays whole. */
function supersedingRepeatSpan(
  superseded: PendingViewportSettleRefresh | undefined,
  span: ParsedDirtyRowSpan | null,
  viewport: ViewportSnapshot
): ParsedDirtyRowSpan | null {
  if (!superseded) {
    return span
  }
  if (!span || !superseded.span || !sameRowGeometry(superseded.viewport, viewport)) {
    return null
  }
  return unionRowSpans(span, superseded.span)
}

function requestRepeatFrame(run: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(run)
    return () => {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(id)
      }
    }
  }
  const id = setTimeout(run, 16)
  return () => clearTimeout(id)
}

function cancelScheduledViewportSettleRefresh(terminal: ForegroundTerminalOutputTarget): void {
  pendingViewportSettleRefreshByTerminal.get(terminal)?.cancel()
  pendingViewportSettleRefreshByTerminal.delete(terminal)
}

function scheduleViewportSettleRefresh(
  terminal: ForegroundTerminalOutputTarget,
  repairedSpan: ParsedDirtyRowSpan | null,
  viewport: ViewportSnapshot,
  shouldRefreshSynchronously?: () => boolean,
  shouldReleaseRenderPause?: () => boolean
): void {
  const span = supersedingRepeatSpan(
    pendingViewportSettleRefreshByTerminal.get(terminal),
    repairedSpan,
    viewport
  )
  cancelScheduledViewportSettleRefresh(terminal)
  const cancel = requestRepeatFrame(() => {
    pendingViewportSettleRefreshByTerminal.delete(terminal)
    refreshVisibleRows(
      terminal,
      shouldRefreshSynchronously?.() ?? true,
      shouldReleaseRenderPause,
      repeatRowSpan(terminal, span, viewport)
    )
  })
  pendingViewportSettleRefreshByTerminal.set(terminal, { span, viewport, cancel })
}

function settleForegroundRender(
  terminal: ForegroundTerminalOutputTarget,
  beforeWriteViewport: ViewportSnapshot,
  options: ForegroundTerminalWriteOptions
): void {
  const afterWriteViewport = captureViewportSnapshot(terminal)
  const span = repairRowSpan(terminal, beforeWriteViewport, afterWriteViewport)
  refreshVisibleRows(
    terminal,
    options.shouldRefreshViewportSynchronously?.() ?? true,
    options.shouldReleaseRenderPause,
    span
  )
  // Why: when output advances the viewport, Chromium can paint the freshly
  // scrolled top row one frame later than xterm finishes parsing. Repaint once
  // more after the scroll settles so the user doesn't need to jiggle the window.
  if (options.followupViewportRefresh || viewportMoved(beforeWriteViewport, afterWriteViewport)) {
    scheduleViewportSettleRefresh(
      terminal,
      span,
      afterWriteViewport,
      options.shouldRefreshViewportSynchronously,
      options.shouldReleaseRenderPause
    )
  }
}

export function writeForegroundTerminalChunk(
  terminal: ForegroundTerminalOutputTarget,
  data: string,
  options: ForegroundTerminalWriteOptions = {}
): boolean {
  const beforeWriteViewport = options.forceViewportRefresh
    ? captureViewportSnapshot(terminal)
    : null
  if (beforeWriteViewport) {
    // Why here and not in the callback: the span must cover only this write's
    // parse, and xterm fires its dirty-row request between the two.
    resetParsedDirtyRows(terminal)
  }
  // Why guarded steps: this callback runs inside xterm's WriteBuffer loop,
  // where an escaping throw permanently wedges the terminal (see
  // xterm-write-callback-guard.ts). Guard settle and onParsed separately so a
  // renderer/WebGL failure during settle can't starve the replay-guard release.
  const runParsedSteps = (): void => {
    if (beforeWriteViewport) {
      runGuardedWriteCompletionStep('foreground-render-settle', () =>
        settleForegroundRender(terminal, beforeWriteViewport, options)
      )
    }
    if (options.onParsed) {
      runGuardedWriteCompletionStep('foreground-on-parsed', options.onParsed)
    }
  }
  try {
    terminal.write(data, runParsedSteps)
    return true
  } catch {
    // Why separate from parse completion: cleanup/recovery must run, but a
    // synchronous write failure is not parser liveness evidence.
    if (options.onWriteFailure) {
      runGuardedWriteCompletionStep('foreground-on-write-failure', options.onWriteFailure)
    }
    return false
  }
}

export function discardForegroundRenderSettle(terminal: ForegroundTerminalOutputTarget): void {
  cancelScheduledViewportSettleRefresh(terminal)
  disposeParsedDirtyRows(terminal)
}
