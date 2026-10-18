import { writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  sendToTerminal,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot,
  waitForTerminalOutput
} from './helpers/terminal'
import { nodeTerminalCommand } from './terminal-node-command'

// Diagnose image placement before changing the cache; this does not resize or repaint it.
test('cache image placement diagnostic before any shrink', async ({ orcaPage }, testInfo) => {
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  await orcaPage.evaluate(async () => {
    await window.__store!.getState().updateSettings({
      terminalInlineImages: true,
      terminalInlineImageCacheMb: 64,
      terminalGpuAcceleration: 'off',
      terminalHiddenViewParking: false
    })
  })
  const identity = await waitForPaneIdentitySnapshot(orcaPage, 1)
  const ptyId = identity.panes[0]?.ptyId
  if (!ptyId) {
    throw new Error('Diagnostic terminal has no PTY')
  }
  const png = new PNG({ width: 1000, height: 1000 })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data.set([240, 40, 40, 255], i)
  }
  const payload = PNG.sync.write(png).toString('base64')
  const physical = `\x1b[3;3H\x1b]1337;File=inline=1;width=100px;height=100px:${payload}\x07`
  const pressure = Array.from(
    { length: 12 },
    (_, i) => `\x1b_Ga=T,f=100,i=${100 + i},U=1,c=1,r=1,q=2;${payload}\x1b\\`
  ).join('')
  const producer = testInfo.outputPath('cache-diagnostic.cjs')
  writeFileSync(
    producer,
    [
      'process.stdin.setRawMode(true); process.stdin.resume();',
      `const physical=${JSON.stringify(physical)}, pressure=${JSON.stringify(pressure)}, physicalWithText=${JSON.stringify(physical.replace('\x1b[3;3H', '\x1b[3;3HL '))};`,
      "function marker(stage) { process.stdout.write('\\x1b[15;1HCACHE_DIAGNOSTIC_'+stage+'\\r\\n'); }",
      "process.stdin.on('data', data => { if(data.includes(113))process.exit(0); if(data.includes(112)){process.stdout.write(pressure);marker('PRESSURE');} if(data.includes(115)){process.stdout.write(physical);marker('SENTINEL_AGAIN');} if(data.includes(102)){process.stdout.write(physicalWithText);marker('TEXT_FLUSH');} });",
      "process.stdout.write('\\x1b[2J'+physical); marker('SOLO');"
    ].join('\n')
  )
  const capture = await orcaPage.evaluateHandle((id) => {
    const chunks: { data: string; seq?: number; transformed?: boolean }[] = []
    const unsubscribe = window.api.pty.onData((event) => {
      if (event.id === id) {
        chunks.push({ data: event.data, seq: event.seq, transformed: event.transformed })
      }
    })
    return { chunks, unsubscribe }
  }, ptyId)
  const snapshots: unknown[] = []
  const snapshot = async (stage: string) => {
    const screen = orcaPage.locator('.pane:visible .xterm-screen').first()
    const pixels = PNG.sync.read(
      await screen.screenshot({ path: testInfo.outputPath(`${stage}.png`) })
    )
    let redPixels = 0
    for (let i = 0; i < pixels.data.length; i += 4) {
      if (pixels.data[i] > 200 && pixels.data[i + 1] < 80 && pixels.data[i + 2] < 80) {
        redPixels++
      }
    }
    const metrics = await orcaPage.evaluate((tabId) => {
      const pane = window.__paneManagers!.get(tabId)!.getActivePane()!
      type StorageImage = {
        orig?: { width: number; height: number }
        actual?: { width: number; height: number }
        virtual?: boolean
        tileCount?: number
        marker?: { line: number }
      }
      type Addon = {
        storageLimit: number
        storageUsage: number
        getImageAtBufferCell(x: number, y: number): HTMLCanvasElement | undefined
        _storage?: { _images: Map<number, StorageImage> }
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: diagnostic observes the xterm addon registry and buffer cell metadata in the controlled terminal.
      const internals = pane.terminal as unknown as {
        _addonManager: { _addons: { instance: Partial<Addon> }[] }
        _core: {
          buffer: {
            lines: { get(y: number): { getExtended(x: number): { payload?: unknown } } | undefined }
          }
        }
      }
      const addon = internals._addonManager._addons
        .map((entry) => entry.instance)
        .find((entry) => typeof entry.getImageAtBufferCell === 'function')
      const buffer = pane.terminal.buffer.active
      const publicHits: {
        x: number
        y: number
        visible: boolean
        width: number
        height: number
        sample: number[]
      }[] = []
      const tileCells: { x: number; y: number; visible: boolean; payload: unknown }[] = []
      const text: { y: number; text: string }[] = []
      for (let y = 0; y < buffer.length; y++) {
        const line = buffer.getLine(y)
        const content = line?.translateToString(true)
        if (content) {
          text.push({ y, text: content })
        }
        for (let x = 0; x < pane.terminal.cols; x++) {
          const visible = y >= buffer.viewportY && y < buffer.viewportY + pane.terminal.rows
          const image = addon?.getImageAtBufferCell?.(x, y)
          if (image) {
            publicHits.push({
              x,
              y,
              visible,
              width: image.width,
              height: image.height,
              sample: Array.from(image.getContext('2d')?.getImageData(0, 0, 1, 1).data ?? [])
            })
          }
          const payload = internals._core.buffer.lines.get(y)?.getExtended(x)?.payload
          if (payload !== undefined) {
            tileCells.push({ x, y, visible, payload })
          }
        }
      }
      const canvases = Array.from(pane.container.querySelectorAll('canvas')).map((canvas) => {
        const style = getComputedStyle(canvas)
        const rect = canvas.getBoundingClientRect()
        let alphaPixels = 0,
          redPixels = 0,
          error = ''
        if (canvas.className.includes('xterm-image')) {
          try {
            const data = canvas
              .getContext('2d')
              ?.getImageData(0, 0, canvas.width, canvas.height).data
            for (let i = 0; data && i < data.length; i += 4) {
              if (data[i + 3]) {
                alphaPixels++
              }
              if (data[i] > 200 && data[i + 1] < 80 && data[i + 2] < 80 && data[i + 3]) {
                redPixels++
              }
            }
          } catch (caught) {
            error = String(caught)
          }
        }
        return {
          className: canvas.className,
          width: canvas.width,
          height: canvas.height,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          zIndex: style.zIndex,
          alphaPixels,
          redPixels,
          error
        }
      })
      return {
        rows: pane.terminal.rows,
        cols: pane.terminal.cols,
        viewportY: buffer.viewportY,
        baseY: buffer.baseY,
        cursorX: buffer.cursorX,
        cursorY: buffer.cursorY,
        length: buffer.length,
        storageLimit: addon?.storageLimit,
        storageUsage: addon?.storageUsage,
        images: [...(addon?._storage?._images.entries() ?? [])].map(([id, spec]) => ({
          id,
          width: spec.orig?.width,
          height: spec.orig?.height,
          actualWidth: spec.actual?.width,
          actualHeight: spec.actual?.height,
          virtual: spec.virtual,
          tileCount: spec.tileCount,
          markerLine: spec.marker?.line
        })),
        text,
        publicHits,
        tileCells,
        canvases
      }
    }, identity.tabId)
    const chunks = await capture.evaluate((state) => state.chunks.splice(0))
    const result = { stage, redPixels, metrics, chunks }
    snapshots.push(result)
    writeFileSync(
      testInfo.outputPath('cache-placement-diagnostic.json'),
      JSON.stringify(snapshots, null, 2)
    )
    return result
  }
  await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([producer]))
  try {
    await waitForTerminalOutput(orcaPage, 'CACHE_DIAGNOSTIC_SOLO', 30_000)
    const solo = await snapshot('solo-sentinel')
    await sendToTerminal(orcaPage, ptyId, 'p')
    await waitForTerminalOutput(orcaPage, 'CACHE_DIAGNOSTIC_PRESSURE', 30_000)
    const pressure = await snapshot('after-pressure')
    await sendToTerminal(orcaPage, ptyId, 's')
    await waitForTerminalOutput(orcaPage, 'CACHE_DIAGNOSTIC_SENTINEL_AGAIN', 30_000)
    await snapshot('sentinel-after-pressure')
    await sendToTerminal(orcaPage, ptyId, 'f')
    await waitForTerminalOutput(orcaPage, 'CACHE_DIAGNOSTIC_TEXT_FLUSH', 30_000)
    await snapshot('printable-prefix-control')
    expect(solo.redPixels).toBeGreaterThan(1000)
    expect(pressure.redPixels).toBeGreaterThan(1000)
  } finally {
    await sendToTerminal(orcaPage, ptyId, 'q')
    await capture.evaluate((state) => state.unsubscribe())
    await capture.dispose()
  }
})
