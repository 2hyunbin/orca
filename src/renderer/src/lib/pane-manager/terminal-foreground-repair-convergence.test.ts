import { Terminal } from '@xterm/headless'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  discardForegroundRenderSettle,
  writeForegroundTerminalChunk,
  type ForegroundTerminalOutputTarget
} from './pane-terminal-foreground-render-settle'

/**
 * Convergence oracle for the narrowed foreground repaint.
 *
 * Invariant (`terminal-geometry.visible-convergence`): the rows Orca asks xterm
 * to repaint after a forced foreground refresh must cover every viewport row
 * whose rendered content changed during that write, plus the cursor row on both
 * sides of it. A renderer whose model was converged before the write is then
 * still converged after it, so narrowing the span can never strand a stale cell.
 *
 * A `null` span means "repaint the whole viewport" and trivially converges; the
 * corpus below also asserts which cases must stay full-grid.
 */

type SpanRequest = { start: number; end: number }

type Harness = {
  terminal: Terminal
  target: ForegroundTerminalOutputTarget
  requests: SpanRequest[]
}

function createHarness(cols = 80, rows = 24): Harness {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true })
  const requests: SpanRequest[] = []
  const target = terminal as unknown as ForegroundTerminalOutputTarget & {
    refresh: (start: number, end: number) => void
  }
  target.refresh = (start: number, end: number) => {
    requests.push({ start, end })
  }
  return { terminal, target, requests }
}

function serializeRow(terminal: Terminal, viewportRow: number): string {
  // Why the offset: `getLine` indexes the whole buffer, so viewport row 0 is the
  // line at `viewportY`. Comparing raw buffer indices would compare scrollback
  // that no write can touch and make the oracle vacuous.
  const line = terminal.buffer.active.getLine(terminal.buffer.active.viewportY + viewportRow)
  if (!line) {
    return '<missing>'
  }
  const parts: string[] = []
  for (let x = 0; x < terminal.cols; x++) {
    const cell = line.getCell(x)
    if (!cell) {
      parts.push('~')
      continue
    }
    parts.push(
      [
        cell.getChars(),
        cell.getWidth(),
        cell.getFgColorMode(),
        cell.getFgColor(),
        cell.getBgColorMode(),
        cell.getBgColor(),
        cell.isBold(),
        cell.isItalic(),
        cell.isDim(),
        cell.isUnderline(),
        cell.isBlink(),
        cell.isInverse(),
        cell.isInvisible(),
        cell.isStrikethrough(),
        cell.isOverline()
      ].join(':')
    )
  }
  return parts.join('|')
}

function snapshotViewport(terminal: Terminal): string[] {
  const rows: string[] = []
  for (let y = 0; y < terminal.rows; y++) {
    rows.push(serializeRow(terminal, y))
  }
  return rows
}

function changedRows(before: string[], after: string[]): number[] {
  const changed: number[] = []
  for (let y = 0; y < Math.max(before.length, after.length); y++) {
    if (before[y] !== after[y]) {
      changed.push(y)
    }
  }
  return changed
}

async function writeAndSettle(harness: Harness, data: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const accepted = writeForegroundTerminalChunk(harness.target, data, {
      forceViewportRefresh: true,
      // Why: headless has no `_core.refresh`, so drive the public `refresh` path
      // the WebGL/async branch uses in the app.
      shouldRefreshViewportSynchronously: () => false,
      onParsed: () => resolve()
    })
    expect(accepted).toBe(true)
  })
}

/** Seed the pane without measuring: plain writes, drained before the oracle runs. */
async function seed(harness: Harness, data: string): Promise<void> {
  await new Promise<void>((resolve) => {
    harness.terminal.write(data, () => resolve())
  })
}

/**
 * Holds queued frames so a test picks what lands before the repeat. Why a stub:
 * Node has no `requestAnimationFrame`, so vitest's fake timers skip faking it.
 */
function stubAnimationFrames(): () => void {
  const queued = new Map<number, FrameRequestCallback>()
  let nextId = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    nextId += 1
    queued.set(nextId, callback)
    return nextId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => queued.delete(id))
  return () => {
    const callbacks = [...queued.values()]
    queued.clear()
    for (const callback of callbacks) {
      callback(0)
    }
  }
}

/** Ask for the delayed repeat too; it stays queued until the test advances a frame. */
async function writeWithFollowup(
  target: ForegroundTerminalOutputTarget,
  data: string
): Promise<void> {
  await new Promise<void>((resolve) => {
    const accepted = writeForegroundTerminalChunk(target, data, {
      forceViewportRefresh: true,
      followupViewportRefresh: true,
      // Why: headless has no `_core.refresh`, so drive the public `refresh` path.
      shouldRefreshViewportSynchronously: () => false,
      onParsed: () => resolve()
    })
    expect(accepted).toBe(true)
  })
}

/** Like `writeAndSettle`, but the repeat runs before returning, so it is `requests[1]`. */
async function writeAndSettleWithFollowup(
  harness: Harness,
  data: string,
  runFrame: () => void
): Promise<void> {
  await writeWithFollowup(harness.target, data)
  runFrame()
}

/**
 * The dirty-row source the production tracker reads through `_core._inputHandler`,
 * which the output-target type does not describe.
 */
type ControllableTerminal = ForegroundTerminalOutputTarget & {
  _core: {
    _inputHandler: {
      onRequestRefreshRows: (listener: (event: SpanRequest) => void) => { dispose: () => void }
    }
  }
}

type ControllableTarget = {
  target: ForegroundTerminalOutputTarget
  requests: SpanRequest[]
  active: { type: string; cursorY: number; baseY: number; viewportY: number }
  size: { rows: number; cols: number }
  setDirty: (span: SpanRequest) => void
}

/**
 * A terminal double whose parse span and geometry a test controls directly.
 * Why a double: a real parse cannot scroll or resize between the repair and its
 * queued repeat.
 */
function createControllableTarget(dirtySpan: SpanRequest, cursorY = 2): ControllableTarget {
  const requests: SpanRequest[] = []
  const active = { type: 'normal', cursorY, baseY: 5, viewportY: 5 }
  const size = { rows: 24, cols: 80 }
  let dirty = dirtySpan
  let listener: ((event: SpanRequest) => void) | undefined
  const target: ControllableTerminal = {
    get rows() {
      return size.rows
    },
    get cols() {
      return size.cols
    },
    buffer: { active },
    refresh: (start: number, end: number) => requests.push({ start, end }),
    write: (_data: string, callback?: () => void) => {
      listener?.(dirty)
      callback?.()
    },
    _core: {
      _inputHandler: {
        onRequestRefreshRows: (next) => {
          listener = next
          return {
            dispose: () => {
              listener = undefined
            }
          }
        }
      }
    }
  }
  return {
    target,
    requests,
    active,
    size,
    setDirty: (span: SpanRequest) => {
      dirty = span
    }
  }
}

type Case = {
  name: string
  setup?: string
  write: string
  /** Whole-viewport repaint is required (scroll, buffer flip, unknown span). */
  expectFullGrid?: boolean
  cols?: number
  rows?: number
}

const SCROLLBACK_SEED = `${Array.from({ length: 40 }, (_, i) => `line ${i} ${'lorem ipsum '.repeat(3)}`).join('\r\n')}\r\n\r\n\r\n\r\n`

const CLAUDE_STYLE_REDRAW = `\x1b[?25l\x1b[4A\x1b[2K* Thinking… (12s)\r\n\x1b[2K  > tool call 3\r\n\x1b[2K  ${'#'.repeat(30)}\r\n\x1b[2K\r\n\x1b[?25h`

const CASES: Case[] = [
  {
    name: 'claude-style in-place redraw of the bottom rows',
    setup: SCROLLBACK_SEED,
    write: CLAUDE_STYLE_REDRAW
  },
  {
    name: 'standalone carriage-return overwrite of the current line',
    setup: `${SCROLLBACK_SEED}some existing prompt text`,
    write: '\rrewritten prompt'
  },
  {
    name: 'backspace erase',
    setup: `${SCROLLBACK_SEED}abcdef`,
    write: '\b\b\b   \b\b\b'
  },
  {
    name: 'erase in line to end',
    setup: `${SCROLLBACK_SEED}${'x'.repeat(70)}`,
    write: '\x1b[20G\x1b[K'
  },
  {
    name: 'erase in line, whole line',
    setup: `${SCROLLBACK_SEED}${'x'.repeat(70)}`,
    write: '\x1b[2K'
  },
  {
    name: 'erase in display from mid-screen to end',
    setup: `${SCROLLBACK_SEED}${Array.from({ length: 10 }, (_, i) => `row ${i} ${'y'.repeat(40)}`).join('\r\n')}`,
    write: '\x1b[12;5H\x1b[J'
  },
  {
    name: 'erase in display, above cursor',
    setup: `${SCROLLBACK_SEED}${Array.from({ length: 10 }, (_, i) => `row ${i} ${'y'.repeat(40)}`).join('\r\n')}`,
    write: '\x1b[12;5H\x1b[1J'
  },
  {
    name: 'full clear then home',
    setup: SCROLLBACK_SEED,
    write: '\x1b[2J\x1b[H'
  },
  {
    name: 'wide CJK glyphs rewritten in place',
    setup: `${SCROLLBACK_SEED}${'漢字テスト'.repeat(6)}`,
    write: '\r\x1b[2K中文字符测试中文字符测试'
  },
  {
    name: 'emoji rewritten in place',
    setup: `${SCROLLBACK_SEED}status: 🚀🚀🚀 building`,
    write: '\r\x1b[2Kstatus: ✅ done 🎉'
  },
  {
    name: 'combining characters rewritten in place',
    setup: `${SCROLLBACK_SEED}café naiÌˆve`,
    write: '\r\x1b[2Kcafé́ é̀̂ done'
  },
  {
    name: 'zero-width-joiner sequence',
    setup: `${SCROLLBACK_SEED}team: `,
    write: '\r\x1b[2Kteam: \u{1F469}‍\u{1F4BB} \u{1F468}‍\u{1F373}'
  },
  {
    name: 'insert lines inside a scroll region',
    setup: `${SCROLLBACK_SEED}${Array.from({ length: 12 }, (_, i) => `region ${i}`).join('\r\n')}`,
    write: '\x1b[5;18r\x1b[8;1H\x1b[3L\x1b[r'
  },
  {
    name: 'delete lines inside a scroll region',
    setup: `${SCROLLBACK_SEED}${Array.from({ length: 12 }, (_, i) => `region ${i}`).join('\r\n')}`,
    write: '\x1b[5;18r\x1b[8;1H\x1b[3M\x1b[r'
  },
  {
    name: 'reverse index at the top of the screen scrolls content down',
    setup: `${SCROLLBACK_SEED}${Array.from({ length: 12 }, (_, i) => `ri ${i}`).join('\r\n')}`,
    write: '\x1b[1;1H\x1bM\x1bM'
  },
  {
    name: 'cursor jump then paint on a far row',
    setup: `${SCROLLBACK_SEED}${Array.from({ length: 12 }, (_, i) => `jump ${i}`).join('\r\n')}`,
    write: '\x1b[2;5Hpainted far away\x1b[K'
  },
  {
    name: 'DEC synchronized-output frame touching scattered rows',
    setup: `${SCROLLBACK_SEED}${Array.from({ length: 20 }, (_, i) => `tui ${i}`).join('\r\n')}`,
    write:
      '\x1b[?2026h\x1b[?25l\x1b[1;2H\x1b[38;2;255;138;0m/ agent\x1b[0m\x1b[9;4Hbody row\x1b[K\x1b[23;2Hstream 0001\x1b[K\x1b[?25h\x1b[?2026l'
  },
  {
    name: 'newline past the bottom scrolls the viewport',
    setup: SCROLLBACK_SEED,
    write: '\x1b[2Kfresh output line\r\n',
    expectFullGrid: true
  },
  {
    name: 'entering the alternate screen',
    setup: SCROLLBACK_SEED,
    write: '\x1b[?1049h\x1b[2J\x1b[H\x1b[Khello alt screen',
    expectFullGrid: true
  },
  {
    name: 'leaving the alternate screen',
    setup: `${SCROLLBACK_SEED}\x1b[?1049h\x1b[2J\x1b[Halt content\x1b[K`,
    write: '\x1b[?1049l\x1b[2K',
    expectFullGrid: true
  },
  {
    name: 'narrow pane, full-width in-place rewrite',
    cols: 40,
    rows: 12,
    setup: 'z'.repeat(38),
    write: `\r\x1b[2K${'q'.repeat(38)}`
  }
]

describe('foreground repaint convergence', () => {
  for (const testCase of CASES) {
    it(`covers every changed row: ${testCase.name}`, async () => {
      const harness = createHarness(testCase.cols ?? 80, testCase.rows ?? 24)
      if (testCase.setup) {
        await seed(harness, testCase.setup)
      }
      const before = snapshotViewport(harness.terminal)
      const cursorBefore = harness.terminal.buffer.active.cursorY
      harness.requests.length = 0

      await writeAndSettle(harness, testCase.write)

      const after = snapshotViewport(harness.terminal)
      const cursorAfter = harness.terminal.buffer.active.cursorY
      expect(harness.requests.length).toBeGreaterThan(0)

      const request = harness.requests[0]!
      const isFullGrid = request.start === 0 && request.end === harness.terminal.rows - 1
      if (testCase.expectFullGrid) {
        expect(isFullGrid).toBe(true)
      }

      const dirty = changedRows(before, after)
      // Guard against a vacuous oracle: every corpus entry must move the screen.
      expect(dirty.length).toBeGreaterThan(0)
      for (const row of dirty) {
        expect(
          row >= request.start && row <= request.end,
          `row ${row} changed but repaint span was ${request.start}..${request.end}`
        ).toBe(true)
      }
      // The cursor row must be repainted: xterm's WebGL model drops the caret
      // whenever an update pass excludes it.
      expect(cursorBefore).toBeGreaterThanOrEqual(request.start)
      expect(cursorBefore).toBeLessThanOrEqual(request.end)
      expect(cursorAfter).toBeGreaterThanOrEqual(request.start)
      expect(cursorAfter).toBeLessThanOrEqual(request.end)

      discardForegroundRenderSettle(harness.target)
      harness.terminal.dispose()
    })
  }

  it('narrows an in-place bottom-row redraw well below the full grid', async () => {
    const harness = createHarness(80, 40)
    await seed(harness, SCROLLBACK_SEED)
    harness.requests.length = 0
    await writeAndSettle(harness, CLAUDE_STYLE_REDRAW)
    const request = harness.requests[0]!
    // Bottom-anchored redraw: the span ends on the cursor row but stays a few
    // rows tall instead of the 40-row grid the old repair requested.
    expect(request.end - request.start + 1).toBeLessThanOrEqual(8)
    expect(request.start).toBeGreaterThan(0)
    discardForegroundRenderSettle(harness.target)
    harness.terminal.dispose()
  })

  it('widens the repair to the cursor rows on both sides of the write', () => {
    // Why a double: xterm's own tracker always happens to include the cursor
    // row, so only a controlled parse span can prove Orca adds it itself. The
    // WebGL model drops the caret when an update pass excludes the cursor row.
    const requests: SpanRequest[] = []
    let fire: (event: { start: number; end: number } | undefined) => void = () => {}
    const active = { type: 'normal', cursorY: 2, baseY: 0, viewportY: 0 }
    const target: ForegroundTerminalOutputTarget = {
      rows: 24,
      buffer: { active },
      refresh: (start, end) => requests.push({ start, end }),
      write: (_data, callback) => {
        fire({ start: 8, end: 9 })
        active.cursorY = 17
        callback?.()
      },
      _core: {
        _inputHandler: {
          onRequestRefreshRows: (listener) => {
            fire = listener
            return { dispose: () => {} }
          }
        }
      }
    } as unknown as ForegroundTerminalOutputTarget
    writeForegroundTerminalChunk(target, 'x', {
      forceViewportRefresh: true,
      shouldRefreshViewportSynchronously: () => false
    })
    expect(requests).toEqual([{ start: 2, end: 17 }])
  })

  it('repaints the whole viewport when the parse span cannot be observed', async () => {
    const requests: SpanRequest[] = []
    const target: ForegroundTerminalOutputTarget = {
      rows: 24,
      buffer: {
        active: { type: 'normal', cursorY: 3, baseY: 0, viewportY: 0 }
      },
      refresh: (start, end) => requests.push({ start, end }),
      write: (_data, callback) => callback?.()
    }
    writeForegroundTerminalChunk(target, 'x', {
      forceViewportRefresh: true,
      shouldRefreshViewportSynchronously: () => false
    })
    expect(requests).toEqual([{ start: 0, end: 23 }])
  })

  it('keeps the follow-up settle repaint on the whole viewport', async () => {
    const harness = createHarness(80, 24)
    await seed(harness, SCROLLBACK_SEED)
    harness.requests.length = 0
    await writeAndSettle(harness, 'scrolling output\r\n')
    // Primary repaint is full-grid because the viewport scrolled.
    expect(harness.requests[0]).toEqual({ start: 0, end: 23 })
    discardForegroundRenderSettle(harness.target)
    harness.terminal.dispose()
  })
})

describe('delayed settle repair span', () => {
  let runFrame: () => void

  beforeEach(() => {
    runFrame = stubAnimationFrames()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  for (const testCase of CASES) {
    it(`repeats coverage without widening: ${testCase.name}`, async () => {
      const harness = createHarness(testCase.cols ?? 80, testCase.rows ?? 24)
      if (testCase.setup) {
        await seed(harness, testCase.setup)
      }
      const before = snapshotViewport(harness.terminal)
      const cursorBefore = harness.terminal.buffer.active.cursorY
      harness.requests.length = 0

      await writeAndSettleWithFollowup(harness, testCase.write, runFrame)

      const after = snapshotViewport(harness.terminal)
      const cursorAfter = harness.terminal.buffer.active.cursorY
      const rows = harness.terminal.rows
      expect(harness.requests.length).toBe(2)
      const immediate = harness.requests[0]!
      const delayed = harness.requests[1]!

      // A repeat may add the caret row, never drop one.
      expect(delayed.start).toBeLessThanOrEqual(immediate.start)
      expect(delayed.end).toBeGreaterThanOrEqual(immediate.end)

      if (testCase.expectFullGrid) {
        expect(immediate).toEqual({ start: 0, end: rows - 1 })
        expect(delayed).toEqual({ start: 0, end: rows - 1 })
      } else if (immediate.start !== 0 || immediate.end !== rows - 1) {
        // The defect: repeating a narrowed repair as `0..rows-1` turns every
        // in-place redraw into a whole-grid cell walk one frame later.
        expect(delayed).not.toEqual({ start: 0, end: rows - 1 })
      }

      for (const row of changedRows(before, after)) {
        expect(
          row >= delayed.start && row <= delayed.end,
          `row ${row} changed but the delayed repair span was ${delayed.start}..${delayed.end}`
        ).toBe(true)
      }
      for (const cursorRow of [cursorBefore, cursorAfter]) {
        expect(
          cursorRow >= delayed.start && cursorRow <= delayed.end,
          `cursor row ${cursorRow} fell outside the delayed repair span ${delayed.start}..${delayed.end}`
        ).toBe(true)
      }

      discardForegroundRenderSettle(harness.target)
      harness.terminal.dispose()
    })
  }

  it('repeats the one-row repair of a native Windows in-place rewrite', async () => {
    // Issue #19622 shape: a 120x60 pane, cursor parked on row 56, then a status
    // rewrite that touches one row and does not scroll the viewport.
    const harness = createHarness(120, 60)
    await seed(harness, Array.from({ length: 59 }, (_, i) => `row ${i}`).join('\r\n'))
    await seed(harness, '\x1b[56;1H')
    harness.requests.length = 0

    await writeAndSettleWithFollowup(harness, '\r\x1b[2Kstatus ...', runFrame)

    expect(harness.requests.length).toBe(2)
    expect(harness.requests[0]).toEqual({ start: 55, end: 55 })
    expect(harness.requests[1]).toEqual({ start: 55, end: 55 })
    discardForegroundRenderSettle(harness.target)
    harness.terminal.dispose()
  })

  it('adds the caret a later write moved, not the rows xterm repaints itself', async () => {
    const double = createControllableTarget({ start: 10, end: 10 }, 10)
    await writeWithFollowup(double.target, 'in-place rewrite')
    expect(double.requests[0]).toEqual({ start: 10, end: 10 })

    double.setDirty({ start: 20, end: 20 })
    double.active.cursorY = 3
    writeForegroundTerminalChunk(double.target, 'later chunk')
    runFrame()

    expect(double.requests[1]).toEqual({ start: 3, end: 10 })
  })

  it('keeps the superseded repair rows when a later write queues its own repeat', async () => {
    // The caret sits outside the parse span, so only the queued repair's own span
    // remembers row 5.
    const double = createControllableTarget({ start: 10, end: 10 }, 5)
    await writeWithFollowup(double.target, 'in-place rewrite')
    expect(double.requests[0]).toEqual({ start: 5, end: 10 })

    double.setDirty({ start: 20, end: 20 })
    double.active.cursorY = 20
    await writeWithFollowup(double.target, 'second rewrite')
    expect(double.requests[1]).toEqual({ start: 20, end: 20 })

    runFrame()

    expect(double.requests).toHaveLength(3)
    expect(double.requests[2]).toEqual({ start: 5, end: 20 })
  })

  it.each([
    ['entering the alternate screen', '\x1b[?1049h\x1b[2J\x1b[Halt screen'],
    ['ending a synchronized-output frame', '\x1b[?2026h\x1b[3;1Hframe\x1b[K\x1b[?2026l']
  ])('keeps a whole-grid repeat that a narrow write supersedes: %s', async (_name, first) => {
    const harness = createHarness(80, 24)
    await seed(harness, SCROLLBACK_SEED)
    harness.requests.length = 0

    // The first write's span is unknown, so its repeat is whole-grid; a status
    // rewrite then lands in the same frame and queues a narrow repeat of its own.
    await writeWithFollowup(harness.target, first)
    await writeWithFollowup(harness.target, '\r\x1b[2Kstatus ...')
    expect(harness.requests[0]).toEqual({ start: 0, end: 23 })
    expect(harness.requests[1]).not.toEqual({ start: 0, end: 23 })
    runFrame()

    expect(harness.requests).toHaveLength(3)
    expect(harness.requests[2]).toEqual({ start: 0, end: 23 })
    discardForegroundRenderSettle(harness.target)
    harness.terminal.dispose()
  })

  // Why resize is here although xterm repaints whole on resize itself
  // (`terminal-foreground-repair-xterm-contract.test.ts`): the repeat must not
  // trust a span recorded against the old rows either way.
  it.each<[string, (double: ControllableTarget) => void]>([
    [
      'the terminal scrolled',
      (double) => {
        double.active.baseY = 9
        double.active.viewportY = 9
      }
    ],
    [
      'the pane was scrolled into scrollback',
      (double) => {
        double.active.viewportY = 2
      }
    ],
    [
      'the rows were resized',
      (double) => {
        double.size.rows = 30
      }
    ],
    [
      'only the columns were resized',
      (double) => {
        double.size.cols = 100
      }
    ],
    [
      'the buffer switched',
      (double) => {
        double.active.type = 'alternate'
      }
    ]
  ])('repaints the whole viewport when %s before the repeat', async (_name, change) => {
    const double = createControllableTarget({ start: 10, end: 10 }, 10)
    await writeWithFollowup(double.target, 'in-place rewrite')
    expect(double.requests[0]).toEqual({ start: 10, end: 10 })

    change(double)
    runFrame()

    expect(double.requests[1]).toEqual({ start: 0, end: double.size.rows - 1 })
  })

  it('repaints the whole viewport while the pane is scrolled into scrollback', async () => {
    // `cursorY` counts from the live screen, not the scrolled viewport, so the
    // caret rows would not address the visible caret.
    const harness = createHarness(80, 24)
    await seed(harness, Array.from({ length: 40 }, (_, i) => `row ${i}`).join('\r\n'))
    await seed(harness, '\x1b[11;1H')
    harness.terminal.scrollLines(-3)
    expect(harness.terminal.buffer.active.viewportY).toBeLessThan(
      harness.terminal.buffer.active.baseY
    )
    harness.requests.length = 0

    await writeAndSettleWithFollowup(harness, '\r\x1b[2Kstatus ...', runFrame)

    expect(harness.requests).toEqual([
      { start: 0, end: 23 },
      { start: 0, end: 23 }
    ])
    discardForegroundRenderSettle(harness.target)
    harness.terminal.dispose()
  })

  it('drops the repeat when the pane is discarded first', async () => {
    const double = createControllableTarget({ start: 10, end: 10 }, 10)
    await writeWithFollowup(double.target, 'in-place rewrite')
    expect(double.requests[0]).toEqual({ start: 10, end: 10 })

    discardForegroundRenderSettle(double.target)
    runFrame()

    expect(double.requests).toHaveLength(1)
  })
})
