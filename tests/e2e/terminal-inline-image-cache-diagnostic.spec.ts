import { writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot,
  waitForTerminalOutput
} from './helpers/terminal'
import { nodeTerminalCommand } from './terminal-node-command'

// Diagnose pressure-first image placement before lowering the cache.
for (const settingsPath of ['ui', 'direct'] as const) {
  test(`cache placement diagnostic pressure-first (${settingsPath})`, async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    test.setTimeout(180_000)
    await waitForSessionReady(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await orcaPage.evaluate(async () => {
      await window.__store!.getState().updateSettings({
        terminalInlineImages: true,
        terminalGpuAcceleration: 'off',
        terminalHiddenViewParking: false,
        theme: 'light'
      })
    })
    await expect
      .poll(() =>
        orcaPage.evaluate(() => {
          const tabId = window.__store!.getState().activeTabId
          const manager = tabId && window.__paneManagers?.get(tabId)
          const pane = manager && manager.getActivePane()
          return Boolean(manager && pane && manager.hasWebglRenderer(pane.id))
        })
      )
      .toBe(false)
    const identity = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const ptyId = identity.panes[0]?.ptyId
    if (!ptyId) {
      throw new Error('Diagnostic terminal has no PTY')
    }
    const mainTrace = await electronApp.evaluateHandle(({ ipcMain }, id) => {
      type Handler = (event: unknown, args: unknown) => unknown
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Electron's invoke registry is checked before wrapping the existing snapshot handler, as in the split latency main probe.
      const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Handler> })
        ._invokeHandlers
      const original = handlers?.get('pty:getMainBufferSnapshot')
      if (!handlers || !original) {
        throw new Error('Snapshot invoke handler unavailable')
      }
      const events: unknown[] = []
      let operation = 0
      const record = (kind: string, detail: unknown) => {
        events.push({ kind, atEpochMs: Date.now(), detail })
      }
      const summarize = (value: unknown) => {
        const read = (key: string): unknown =>
          value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined
        const data = read('data'),
          frame = read('frameRestoreAnsi'),
          scrollback = read('scrollbackAnsi')
        return {
          isNull: value === null,
          seq: read('seq'),
          pendingDeliveryStartSeq: read('pendingDeliveryStartSeq'),
          source: read('source'),
          cols: read('cols'),
          rows: read('rows'),
          alternateScreen: read('alternateScreen'),
          carriesNormalBuffer: read('carriesNormalBuffer'),
          kittyKeyboardFlags: read('kittyKeyboardFlags'),
          terminalOwner: read('terminalOwner'),
          dataLength: typeof data === 'string' ? data.length : null,
          dataPrefix: typeof data === 'string' ? data.slice(0, 256) : null,
          frameLength: typeof frame === 'string' ? frame.length : null,
          scrollbackLength: typeof scrollback === 'string' ? scrollback.length : null
        }
      }
      const wrapper: Handler = function (event, args) {
        if (args === null || typeof args !== 'object' || !('id' in args) || args.id !== id) {
          return original(event, args)
        }
        const request = ++operation
        record('snapshot-request', { request, args })
        try {
          const result = original(event, args)
          if (result instanceof Promise) {
            void result.then(
              (value) => record('snapshot-response', { request, snapshot: summarize(value) }),
              (error) => record('snapshot-rejected', { request, error: String(error) })
            )
          } else {
            record('snapshot-response', { request, snapshot: summarize(result) })
          }
          return result
        } catch (error) {
          record('snapshot-threw', { request, error: String(error) })
          throw error
        }
      }
      handlers.set('pty:getMainBufferSnapshot', wrapper)
      const ack = (_event: unknown, args: unknown) => {
        if (args !== null && typeof args === 'object' && 'id' in args && args.id === id) {
          record('snapshot-ack', args)
        }
      }
      ipcMain.on('pty:hiddenOutputRestoreApplied', ack)
      record('snapshot-probe-installed', { id })
      return {
        events,
        unsubscribe: () => {
          if (handlers.get('pty:getMainBufferSnapshot') === wrapper) {
            handlers.set('pty:getMainBufferSnapshot', original)
          }
          ipcMain.removeListener('pty:hiddenOutputRestoreApplied', ack)
        }
      }
    }, ptyId)
    const deliveryTrace = await orcaPage.evaluateHandle((id) => {
      const events: unknown[] = []
      const unsubscribeMarker = window.api.pty.onModelRestoreNeeded((event) => {
        if (event.id === id) {
          events.push({ kind: 'restore-marker', atEpochMs: Date.now(), event })
        }
      })
      const unsubscribeData = window.api.pty.onData((event) => {
        if (event.id === id) {
          events.push({
            kind: 'delivery-data',
            atEpochMs: Date.now(),
            seq: event.seq,
            rawLength: event.rawLength,
            length: event.data.length,
            transformed: event.transformed,
            imageHeader: event.data.includes('\x1b_G') || event.data.includes('\x1b]1337;'),
            prefix: event.data.slice(0, 128)
          })
        }
      })
      events.push({ kind: 'delivery-probe-installed', atEpochMs: Date.now(), id })
      return {
        events,
        unsubscribe: () => {
          unsubscribeMarker()
          unsubscribeData()
        }
      }
    }, ptyId)
    if (settingsPath === 'ui') {
      await orcaPage.evaluate(() => {
        const state = window.__store!.getState()
        state.openSettingsTarget({ pane: 'terminal', repoId: null })
        state.openSettingsPage()
      })
      const control = orcaPage.getByRole('combobox', {
        name: 'Inline image cache size',
        exact: true
      })
      await control.scrollIntoViewIfNeeded()
      await control.click()
      await orcaPage.getByRole('option', { name: '64 MB', exact: true }).click()
      await expect(control).toHaveText('64 MB')
      await expect
        .poll(() =>
          orcaPage.evaluate(() =>
            window.api.settings.get().then((settings) => settings.terminalInlineImageCacheMb)
          )
        )
        .toBe(64)
      await orcaPage.screenshot({ path: testInfo.outputPath('settings-64.png') })
      await orcaPage.evaluate(() => window.__store!.getState().closeSettingsPage())
      await waitForActiveTerminalManager(orcaPage, 30_000)
    } else {
      await orcaPage.evaluate(async () => {
        await window.__store!.getState().updateSettings({ terminalInlineImageCacheMb: 64 })
      })
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
    )
    const producer = testInfo.outputPath('cache-diagnostic.cjs')
    writeFileSync(
      producer,
      [
        `const physical=${JSON.stringify(physical)}, pressure=${JSON.stringify(pressure)}, physicalWithText=${JSON.stringify(physical.replace('\x1b[3;3H', '\x1b[3;3HL '))};`,
        'const stage=process.argv[2];',
        "if(stage==='INITIAL') { process.stdout.write('\\x1bc'); for(const sequence of pressure) process.stdout.write(sequence); }",
        "process.stdout.write((stage==='TEXT_FLUSH'?physicalWithText:physical)+'\\x1b[15;1HCACHE_DIAGNOSTIC_'+stage+'\\r\\n');"
      ].join('\n')
    )
    const capture = await orcaPage.evaluateHandle(
      ({ id, tabId }) => {
        const pane = window.__paneManagers!.get(tabId)!.getActivePane()!
        const terminal = pane.terminal
        type Marker = {
          line: number
          id: number
          isDisposed: boolean
          dispose(): void
          onDispose(listener: () => void): { dispose(): void }
        }
        type Image = {
          orig?: { width: number; height: number }
          marker?: Marker
          tileCount?: number
          virtual?: boolean
        }
        type Storage = { _images: Map<number, Image>; _delImg(id: number): void }
        type Addon = {
          _storage?: Storage
          storageLimit?: number
          storageUsage?: number
          onImageAdded?: (listener: () => void) => { dispose(): void }
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the diagnostic verifies the loaded addon's storage map and deletion method before observing it.
        const internals = terminal as unknown as {
          _addonManager: { _addons: { instance: Addon }[] }
          _core: { write(data: string | Uint8Array, callback?: () => void): void }
        }
        if (typeof internals._core?.write !== 'function') {
          throw new Error('Core terminal write unavailable for trace')
        }
        const addon = internals._addonManager._addons
          .map((entry) => entry.instance)
          .find(
            (entry) =>
              typeof entry._storage?._delImg === 'function' && entry._storage._images instanceof Map
          )
        const storage = addon?._storage
        if (!storage) {
          throw new Error('Image storage unavailable for deletion trace')
        }
        const chunks: { data: string; seq?: number; transformed?: boolean }[] = []
        const events: unknown[] = []
        const state = () => {
          const buffer = terminal.buffer.active
          const store = window.__store!.getState()
          return {
            rows: terminal.rows,
            cols: terminal.cols,
            viewportY: buffer.viewportY,
            baseY: buffer.baseY,
            cursorX: buffer.cursorX,
            cursorY: buffer.cursorY,
            length: buffer.length,
            activeView: store.activeView,
            activeTabId: store.activeTabId,
            cacheSetting: store.settings?.terminalInlineImageCacheMb,
            storageLimit: addon?.storageLimit,
            storageUsage: addon?.storageUsage,
            images: [...storage._images.entries()].map(([imageId, image]) => ({
              imageId,
              width: image.orig?.width,
              height: image.orig?.height,
              tileCount: image.tileCount,
              virtual: image.virtual,
              markerId: image.marker?.id,
              markerLine: image.marker?.line,
              markerDisposed: image.marker?.isDisposed
            }))
          }
        }
        const record = (kind: string, detail: unknown = null) => {
          events.push({
            kind,
            detail,
            time: performance.now(),
            atEpochMs: Date.now(),
            stack: new Error(kind).stack,
            state: state()
          })
        }
        const describeWrite = (data: string | Uint8Array) => {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
          return {
            type: typeof data === 'string' ? 'string' : 'bytes',
            length: data.length,
            prefix: text.slice(0, 512),
            suffix: text.slice(-128),
            containsED2: text.includes('\x1b[2J'),
            containsED3: text.includes('\x1b[3J'),
            eraseSequences: text.match(/\[[0-9;?]*J/g)?.slice(0, 16) ?? []
          }
        }
        const write = terminal.write
        terminal.write = function (data, callback) {
          record('terminal-write', describeWrite(data))
          write.call(terminal, data, callback)
        }
        const writeln = terminal.writeln
        terminal.writeln = function (data, callback) {
          record('terminal-writeln', describeWrite(data))
          writeln.call(terminal, data, callback)
        }
        const coreWrite = internals._core.write
        internals._core.write = function (data, callback) {
          record('core-write', describeWrite(data))
          coreWrite.call(internals._core, data, callback)
        }
        const deleteImage = storage._delImg
        storage._delImg = function (imageId) {
          record('storage-delete-before', { imageId })
          deleteImage.call(storage, imageId)
          record('storage-delete-after', { imageId })
        }
        const resize = terminal.resize
        terminal.resize = function (cols, rows) {
          record('terminal-resize-before', { cols, rows })
          resize.call(terminal, cols, rows)
          record('terminal-resize-after', { cols, rows })
        }
        const observedMarkers = new WeakSet<Marker>()
        const restoreMarkers: (() => void)[] = []
        const subscriptions = [
          terminal.onResize((event) => record('on-resize', event)),
          terminal.onScroll((position) => record('on-scroll', { position })),
          terminal.onLineFeed(() => record('on-line-feed')),
          terminal.parser.registerCsiHandler({ final: 'J' }, (params) => {
            record('parser-csi-J', { params })
            return false
          })
        ]
        const added = addon?.onImageAdded?.(() => {
          record('on-image-added')
          for (const [imageId, image] of storage._images) {
            const marker = image.marker
            if (!marker || observedMarkers.has(marker)) {
              continue
            }
            observedMarkers.add(marker)
            const dispose = marker.dispose
            marker.dispose = function () {
              record('marker-dispose-before', { imageId, markerId: marker.id })
              dispose.call(marker)
              record('marker-dispose-after', { imageId, markerId: marker.id })
            }
            restoreMarkers.push(() => {
              marker.dispose = dispose
            })
            subscriptions.push(
              marker.onDispose(() => record('marker-on-dispose', { imageId, markerId: marker.id }))
            )
          }
        })
        if (added) {
          subscriptions.push(added)
        }
        const unsubscribe = window.api.pty.onData((event) => {
          if (event.id === id) {
            chunks.push({ data: event.data, seq: event.seq, transformed: event.transformed })
            record('pty-chunk', { length: event.data.length, seq: event.seq })
          }
        })
        record('trace-installed')
        return {
          chunks,
          events,
          unsubscribe: () => {
            unsubscribe()
            for (const subscription of subscriptions) {
              subscription.dispose()
            }
            for (const restore of restoreMarkers) {
              restore()
            }
            storage._delImg = deleteImage
            terminal.resize = resize
            terminal.write = write
            terminal.writeln = writeln
            internals._core.write = coreWrite
          }
        }
      },
      { id: ptyId, tabId: identity.tabId }
    )
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
              lines: {
                get(y: number): { getExtended(x: number): { payload?: unknown } } | undefined
              }
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
      const events = await capture.evaluate((state) => state.events.splice(0))
      const mainEvents = await mainTrace.evaluate((state) => state.events.splice(0))
      const deliveryEvents = await deliveryTrace.evaluate((state) => state.events.splice(0))
      const freezeReport = await orcaPage.evaluate(async () => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the existing production freeze report is called only when its installed function is present.
        const target = window as Window & { __orcaTerminalFreezeReport?: () => Promise<unknown> }
        return typeof target.__orcaTerminalFreezeReport === 'function'
          ? target.__orcaTerminalFreezeReport()
          : null
      })
      const result = {
        stage,
        redPixels,
        metrics,
        chunks,
        events,
        mainEvents,
        deliveryEvents,
        freezeReport
      }
      snapshots.push(result)
      writeFileSync(
        testInfo.outputPath('cache-placement-diagnostic.json'),
        JSON.stringify(snapshots, null, 2)
      )
      return result
    }
    try {
      await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([producer, 'INITIAL']))
      await waitForTerminalOutput(orcaPage, 'CACHE_DIAGNOSTIC_INITIAL', 30_000)
      await expect
        .poll(async () =>
          orcaPage.evaluate((tabId) => {
            const terminal = window.__paneManagers!.get(tabId)!.getActivePane()!.terminal
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the diagnostic inspects only the loaded addon's shared decoded storage.
            const internals = terminal as unknown as {
              _addonManager: {
                _addons: { instance: { _storage?: { _images?: Map<number, unknown> } } }[]
              }
            }
            return (
              internals._addonManager._addons.find((entry) => entry.instance._storage?._images)
                ?.instance._storage?._images?.size ?? 0
            )
          }, identity.tabId)
        )
        .toBe(13)
      const initial = await snapshot('pressure-first')
      await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([producer, 'SENTINEL_AGAIN']))
      await waitForTerminalOutput(orcaPage, 'CACHE_DIAGNOSTIC_SENTINEL_AGAIN', 30_000)
      await snapshot('sentinel-after-pressure')
      await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([producer, 'TEXT_FLUSH']))
      await waitForTerminalOutput(orcaPage, 'CACHE_DIAGNOSTIC_TEXT_FLUSH', 30_000)
      await snapshot('printable-prefix-control')
      expect(initial.redPixels).toBeGreaterThan(1000)
    } finally {
      await capture.evaluate((state) => state.unsubscribe())
      await capture.dispose()
      await deliveryTrace.evaluate((state) => state.unsubscribe())
      await deliveryTrace.dispose()
      await mainTrace.evaluate((state) => state.unsubscribe())
      await mainTrace.dispose()
    }
  })
}
