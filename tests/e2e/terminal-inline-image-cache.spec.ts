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
import { readInlineImageResources } from './helpers/terminal-inline-image-proof'
import { nodeTerminalCommand } from './terminal-node-command'

for (const renderer of ['off', 'on'] as const) {
  const rendererTag = renderer === 'on' ? '@headful ' : ''
  test(`${rendererTag}image cache setting resizes live storage and new split panes (${renderer})`, async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(180_000)
    await waitForSessionReady(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await orcaPage.evaluate(async (gpu) => {
      await window.__store!.getState().updateSettings({
        terminalInlineImages: true,
        terminalHiddenViewParking: false,
        terminalGpuAcceleration: gpu,
        theme: gpu === 'on' ? 'dark' : 'light'
      })
    }, renderer)
    await expect
      .poll(() =>
        orcaPage.evaluate(() => {
          const tabId = window.__store!.getState().activeTabId
          const manager = tabId && window.__paneManagers?.get(tabId)
          const pane = manager && manager.getActivePane()
          return Boolean(manager && pane && manager.hasWebglRenderer(pane.id))
        })
      )
      .toBe(renderer === 'on')
    const identity = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const ptyId = identity.panes[0]?.ptyId
    if (!ptyId) {
      throw new Error('Cache proof terminal has no PTY')
    }
    const sample = async () => (await readInlineImageResources(orcaPage, [identity.tabId]))[0]
    const selectCache = async (mb: number) => {
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
      await orcaPage.getByRole('option', { name: `${mb} MB`, exact: true }).click()
      await expect(control).toHaveText(`${mb} MB`)
      await expect
        .poll(() =>
          orcaPage.evaluate(() =>
            window.api.settings.get().then((settings) => settings.terminalInlineImageCacheMb)
          )
        )
        .toBe(mb)
      await orcaPage.screenshot({ path: testInfo.outputPath(`settings-${mb}.png`) })
      await orcaPage.evaluate(() => window.__store!.getState().closeSettingsPage())
      await waitForActiveTerminalManager(orcaPage, 30_000)
    }
    const png = new PNG({ width: 1000, height: 1000 })
    for (let offset = 0; offset < png.data.length; offset += 4) {
      png.data.set([240, 40, 40, 255], offset)
    }
    const payload = PNG.sync.write(png).toString('base64')
    const producer = testInfo.outputPath('cache-images.cjs')
    writeFileSync(
      producer,
      `process.stdout.write('\\x1bc'); for(let i=0;i<12;i++) process.stdout.write('\\x1b_Ga=T,f=100,i='+(100+i)+',U=1,c=1,r=1,q=2;${payload}\\x1b\\\\'); process.stdout.write('\\x1b[3;3H\\x1b]1337;File=inline=1;width=100px;height=100px:${payload}\\x07\\x1b[15;1HCACHE_PRESSURE_DONE\\r\\n')`
    )
    const assertImagePixels = async (stage: string) => {
      await expect
        .poll(
          async () => {
            const screen = orcaPage.locator('.pane:visible .xterm-screen').first()
            const screenshot = PNG.sync.read(
              await screen.screenshot({ path: testInfo.outputPath(`terminal-${stage}.png`) })
            )
            let redPixels = 0
            for (let offset = 0; offset < screenshot.data.length; offset += 4) {
              if (
                screenshot.data[offset] > 200 &&
                screenshot.data[offset + 1] < 80 &&
                screenshot.data[offset + 2] < 80
              ) {
                redPixels++
              }
            }
            return redPixels
          },
          { message: `Retained image pixels ${stage}` }
        )
        .toBeGreaterThan(1000)
    }
    await selectCache(64)
    await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([producer]))
    await waitForTerminalOutput(orcaPage, 'CACHE_PRESSURE_DONE', 30_000)
    await expect.poll(async () => (await sample()).storageMB).toBeGreaterThan(32)
    const before = await sample()
    expect(before.images).toBe(13)
    await assertImagePixels('before-shrink')
    await selectCache(32)
    await expect.poll(async () => (await sample()).storageMB).toBeLessThanOrEqual(32)
    const shrunk = await sample()
    expect(shrunk.images).toBeLessThan(before.images)
    await assertImagePixels('after-shrink')
    await selectCache(64)
    await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([producer]))
    await waitForTerminalOutput(orcaPage, 'CACHE_PRESSURE_DONE', 30_000)
    await expect.poll(async () => (await sample()).storageMB).toBeGreaterThan(32)
    const grown = await sample()
    const splitLimit = await orcaPage.evaluate((tabId) => {
      const manager = window.__paneManagers!.get(tabId)!
      const pane = manager.splitPane(manager.getActivePane()!.id, 'vertical')!
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inspect the loaded image addon through xterm's addon registry for this renderer contract.
      const terminal = pane.terminal as unknown as {
        _addonManager: { _addons: { instance: { storageLimit?: number } }[] }
      }
      return terminal._addonManager._addons.find(
        (entry) => typeof entry.instance.storageLimit === 'number'
      )?.instance.storageLimit
    }, identity.tabId)
    expect(splitLimit).toBe(64)
    await orcaPage.evaluate(async () => {
      await window.__store!.getState().updateSettings({ terminalInlineImages: false })
    })
    await expect.poll(async () => (await sample()).addon).toBe(false)
    await orcaPage.evaluate(async () => {
      await window.__store!.getState().updateSettings({ terminalInlineImages: true })
    })
    await expect.poll(async () => (await sample()).addon).toBe(true)
    writeFileSync(
      testInfo.outputPath('cache-samples.json'),
      JSON.stringify({ renderer, before, shrunk, grown, splitLimit }, null, 2)
    )
  })
}
