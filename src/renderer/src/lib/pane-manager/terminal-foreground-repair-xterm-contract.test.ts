// @vitest-environment happy-dom
/**
 * The xterm behaviour the delayed foreground repeat
 * (`pane-terminal-foreground-render-settle.ts`) leaves to xterm instead of
 * repainting itself, pinned against the vendored @xterm/xterm 6.1.0-beta.303:
 *
 * - rows a later write parses are rendered from xterm's own request, including
 *   its whole-viewport `undefined` one (`src/browser/CoreBrowserTerminal.ts`,
 *   `onRequestRefreshRows` -> `refresh`);
 * - a renderer swap repaints the whole viewport (`src/browser/services/RenderService.ts`,
 *   `setRenderer` -> `_fullRefresh`), which is how the WebGL addon attaches and detaches;
 * - a resize repaints the whole viewport (same file, `bufferService.onResize` -> `_fullRefresh`).
 *
 * If one of these fails after an xterm bump, the repeat has to cover that case itself.
 */
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type RowRange = { start: number; end: number }

type RenderServiceProbe = {
  refreshRows: (start: number, end: number) => void
  setRenderer: (renderer: unknown) => void
}

type CoreProbe = {
  _renderService: RenderServiceProbe
  _createRenderer: () => unknown
}

const openTerminals: Terminal[] = []

function openTerminal(): { terminal: Terminal; core: CoreProbe; refreshed: RowRange[] } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: 80, rows: 24 })
  terminal.open(container)
  openTerminals.push(terminal)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm 6.1.0-beta.303's Terminal holds a CoreBrowserTerminal with these private members; the tests fail if they move.
  const core = (terminal as unknown as { _core: CoreProbe })._core
  const refreshed: RowRange[] = []
  vi.spyOn(core._renderService, 'refreshRows').mockImplementation((start, end) => {
    refreshed.push({ start, end })
  })
  return { terminal, core, refreshed }
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

describe('xterm repaints the repeat leaves to it', () => {
  beforeEach(() => {
    // happy-dom has no 2d context, which the DOM renderer's WidthCache requires.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the DOM renderer's WidthCache only calls measureText.
      { measureText: () => ({ width: 10 }) } as unknown as CanvasRenderingContext2D
    )
  })

  afterEach(() => {
    while (openTerminals.length > 0) {
      openTerminals.pop()?.dispose()
    }
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('renders the rows a write parses without a caller request', async () => {
    const { terminal, refreshed } = openTerminal()

    await write(terminal, '\x1b[11;1H')
    refreshed.length = 0

    await write(terminal, 'changed')

    expect(refreshed).toContainEqual({ start: 10, end: 10 })
  })

  it('renders the whole viewport when a parse asks for it', async () => {
    const { terminal, refreshed } = openTerminal()

    await write(terminal, '\x1b[?2026h\x1b[3;1Hframe\x1b[?2026l')

    expect(refreshed).toContainEqual({ start: 0, end: 23 })
  })

  it('renders the whole viewport when the renderer is swapped', () => {
    const { core, refreshed } = openTerminal()

    core._renderService.setRenderer(core._createRenderer())

    expect(refreshed).toEqual([{ start: 0, end: 23 }])
  })

  it.each([
    ['rows', 80, 30],
    ['columns only', 100, 24]
  ])('renders the whole viewport on a resize of the %s', (_name, cols, rows) => {
    const { terminal, refreshed } = openTerminal()

    terminal.resize(cols, rows)

    expect(refreshed).toContainEqual({ start: 0, end: rows - 1 })
  })
})
