import { writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { enableInlineImages } from './helpers/terminal-inline-image-proof'
import { nodeTerminalCommand } from './terminal-node-command'

function placementPayload(blue = false): string {
  const png = new PNG({ width: 120, height: 36 })
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data.set(blue ? [40, 40, 240, 255] : [240, 40, 40, 255], offset)
  }
  const image = PNG.sync.write(png).toString('base64')
  const placement = `\x1b_Ga=T,f=100,i=7,C=1,c=12,r=2,q=2;${image}\x1b\\`
  return blue
    ? `\x1b[8;1H${placement}`
    : `\x1bc${placement}\x1b[5;1H\x1b_Ga=p,i=7,C=1,c=12,r=2,q=2;\x1b\\` +
        '\x1b[12;1HKEEP THIS TEXT\r\nOWNERSHIP_READY\r\n'
}

test.use({
  launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' },
  orcaAppExtraArgs: ['--force-color-profile=srgb']
})

for (const acceleration of ['off', 'on'] as const) {
  const rendererTag = acceleration === 'on' ? '@headful ' : ''
  test(`${rendererTag}${acceleration}: deleting and replacing repeated Kitty placements releases all old pixels`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await orcaPage.evaluate(async (policy) => {
      await window.__store!.getState().updateSettings({ terminalGpuAcceleration: policy })
    }, acceleration)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await enableInlineImages(orcaPage)
    await expect
      .poll(() =>
        orcaPage.evaluate(() => {
          const id = window.__store!.getState().activeTabId
          const manager = id && window.__paneManagers?.get(id)
          const pane = manager && manager.getActivePane()
          return Boolean(manager && pane && manager.hasWebglRenderer(pane.id))
        })
      )
      .toBe(acceleration === 'on')
    const ptyId = await waitForActivePanePtyId(orcaPage)
    const producer = testInfo.outputPath('physical-placement-producer.cjs')
    const initial = Buffer.from(placementPayload()).toString('base64')
    const replacement = Buffer.from(placementPayload(true)).toString('base64')
    writeFileSync(
      producer,
      `process.stdin.setRawMode(true);
process.stdin.on('data', data => {
  const key = data.toString();
  if (key === 'q') process.exit(0);
  const output = key === 'd' ? '\\x1b_Ga=d,d=A,q=2;\\x1b\\\\'
    : Buffer.from(key === 'r' ? '${replacement}' : '${initial}', 'base64');
  process.stdout.write(output);
});
process.stdout.write(Buffer.from('${initial}', 'base64'));`
    )
    await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([producer]))
    await waitForTerminalOutput(orcaPage, 'OWNERSHIP_READY', 30_000)
    const screen = orcaPage.locator('.pane:visible .xterm-screen').first()
    const pixels = async (stage: string) => {
      const png = PNG.sync.read(
        await screen.screenshot({ path: testInfo.outputPath(`${stage}.png`) })
      )
      let red = 0
      let blue = 0
      for (let offset = 0; offset < png.data.length; offset += 4) {
        if (png.data[offset] > 220 && png.data[offset + 1] < 60 && png.data[offset + 2] < 60) {
          red++
        }
        if (png.data[offset] < 60 && png.data[offset + 1] < 60 && png.data[offset + 2] > 220) {
          blue++
        }
      }
      return { red, blue }
    }
    await expect.poll(async () => (await pixels('two-placements')).red).toBeGreaterThan(2000)
    await sendToTerminal(orcaPage, ptyId, 'd')
    await expect.poll(() => pixels('deleted')).toEqual({ red: 0, blue: 0 })
    await sendToTerminal(orcaPage, ptyId, 'i')
    await expect.poll(async () => (await pixels('restored')).red).toBeGreaterThan(2000)
    await sendToTerminal(orcaPage, ptyId, 'r')
    await expect
      .poll(async () => {
        const result = await pixels('replaced')
        return { red: result.red, blue: result.blue > 1000 }
      })
      .toEqual({ red: 0, blue: true })
    await waitForTerminalOutput(orcaPage, 'KEEP THIS TEXT', 5000)
    await sendToTerminal(orcaPage, ptyId, 'q')
  })
}
