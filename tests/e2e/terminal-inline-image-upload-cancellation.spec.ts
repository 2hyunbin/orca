import { writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { enableInlineImages } from './helpers/terminal-inline-image-proof'
import { nodeTerminalCommand } from './terminal-node-command'

function image(color: readonly number[]): string {
  const pixels = new PNG({ width: 80, height: 48 })
  for (let offset = 0; offset < pixels.data.length; offset += 4) {
    pixels.data.set(color, offset)
  }
  return PNG.sync.write(pixels).toString('base64')
}
const red = image([255, 0, 0, 255])
const green = image([0, 255, 0, 255])
const blue = image([0, 0, 255, 255])
const osc = (payload: string) => `\x1b]1337;${payload}\x07`
const kitty = (command: string, payload = '') => `\x1b_G${command};${payload}\x1b\\`
const header = 'MultipartFile=inline=1;width=80px;height=48px;preserveAspectRatio=0'

test.use({
  launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' },
  orcaAppExtraArgs: ['--force-color-profile=srgb']
})
for (const acceleration of ['off', 'on'] as const) {
  const rendererTag = acceleration === 'on' ? '@headful ' : ''
  for (const protocol of ['IIP', 'Kitty'] as const) {
    for (const failure of ['CAN', 'SUB', 'Base64 failure'] as const) {
      test(`${rendererTag}${acceleration}: ${protocol} ${failure} cancels only its upload and recovers`, async ({
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
        const pty = await waitForActivePanePtyId(orcaPage)
        const marker = 'UPLOAD_RECOVERY_DONE'
        const cancel = failure === 'CAN' ? '\x18' : '\x1a'
        let upload: string
        if (protocol === 'IIP') {
          const invalid =
            failure === 'Base64 failure'
              ? `${'!'.repeat(131072)}\x07`
              : `${red.slice(4, 8)}${cancel}`
          upload = `${osc(header)}${osc(`FilePart=${red.slice(0, 4)}`)}\x1b]1337;FilePart=${invalid}${osc(`FilePart=${red.slice(8)}`)}${osc('FileEnd')}\x1b[9;3H${osc(header)}${osc(`FilePart=${green}`)}${osc('FileEnd')}`
        } else {
          const invalid =
            failure === 'Base64 failure'
              ? `${'!'.repeat(131072)}\x1b\\`
              : `${red.slice(4, 8)}${cancel}`
          upload = `${kitty('a=T,f=100,i=7,m=1,q=2', red.slice(0, 4))}${kitty('a=T,f=100,i=9,m=1,q=2', green.slice(0, 4))}\x1b_Gi=7,m=1,q=2;${invalid}\x1b[9;3H${kitty('m=0,q=2', green.slice(4))}\x1b[13;3H${kitty('a=T,f=100,i=7,q=2', blue)}`
        }
        const payload = `\x1bc\x1b[?25lNEIGHBOR TEXT\x1b[3;3H${upload}\x1b[19;1H${marker}\r\n`
        const producer = testInfo.outputPath('upload-recovery.cjs')
        writeFileSync(
          producer,
          `process.stdout.write(Buffer.from('${Buffer.from(payload).toString('base64')}', 'base64'))`
        )
        await execInTerminal(orcaPage, pty, nodeTerminalCommand([producer]))
        await waitForTerminalOutput(orcaPage, marker, 30_000)
        const neighboringText = await orcaPage.evaluate(() => {
          const tab = window.__store!.getState().activeTabId
          const pane = tab && window.__paneManagers?.get(tab)?.getActivePane()
          return pane && pane.terminal.buffer.active.getLine(0)?.translateToString(true)
        })
        expect(neighboringText).toBe('NEIGHBOR TEXT')
        const screen = orcaPage.locator('.pane:visible .xterm-screen').first()
        await expect
          .poll(
            async () => {
              const pixels = PNG.sync.read(
                await screen.screenshot({ path: testInfo.outputPath('upload-recovery.png') })
              )
              const counts = { red: 0, green: 0, blue: 0, text: 0 }
              const background = pixels.data.subarray(
                Math.min(200, pixels.width - 1) * 4,
                Math.min(200, pixels.width - 1) * 4 + 3
              )
              for (let offset = 0; offset < pixels.data.length; offset += 4) {
                const [r, g, b] = pixels.data.subarray(offset, offset + 3)
                const x = (offset / 4) % pixels.width
                if (
                  offset < pixels.width * 20 * 4 &&
                  x < 130 &&
                  Math.abs(r - background[0]) +
                    Math.abs(g - background[1]) +
                    Math.abs(b - background[2]) >
                    120
                ) {
                  counts.text++
                }
                if (r > 240 && g < 15 && b < 15) {
                  counts.red++
                }
                if (g > 240 && r < 15 && b < 15) {
                  counts.green++
                }
                if (b > 240 && r < 15 && g < 15) {
                  counts.blue++
                }
              }
              return (
                counts.red === 0 &&
                counts.text > 30 &&
                counts.green > 1000 &&
                (protocol === 'IIP' || counts.blue > 1000)
              )
            },
            {
              timeout: 30_000,
              message: 'Canceled red is absent; unrelated green and reused blue images render'
            }
          )
          .toBe(true)
      })
    }
  }
}
