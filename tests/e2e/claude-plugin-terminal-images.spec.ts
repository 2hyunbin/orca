import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { resolveClaudeCommand } from '../../src/shared/node-cli-command-resolution'
import { createClaudePluginImageFixture } from './helpers/claude-plugin-image-fixture'
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

const enabled = process.env.ORCA_REAL_CLAUDE_PLUGIN_TEST === '1'
const command = process.env.ORCA_REAL_CLAUDE_COMMAND || resolveClaudeCommand()

test.use({
  launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' },
  orcaAppExtraArgs: ['--force-color-profile=srgb']
})
test.skip(!enabled, 'Set ORCA_REAL_CLAUDE_PLUGIN_TEST=1 to run the installed Claude UI')

for (const acceleration of ['off', 'on'] as const) {
  for (const managed of [false, true]) {
    test(`@headful ${acceleration}: real Claude plugin ${managed ? 'managed launch renders bytes and host files' : 'reports unsupported automatic detection'}`, async ({
      orcaPage
    }, testInfo) => {
      await waitForSessionReady(orcaPage)
      await ensureTerminalVisible(orcaPage)
      await orcaPage.evaluate(async (policy) => {
        await window.__store!.getState().updateSettings({ terminalGpuAcceleration: policy })
      }, acceleration)
      await waitForActiveTerminalManager(orcaPage)
      await enableInlineImages(orcaPage)
      const { launcher, gateReceipt, cleanup } = createClaudePluginImageFixture(
        testInfo.outputPath('claude'),
        command,
        managed ? 'managed' : false
      )
      if (managed) {
        await orcaPage.evaluate(
          (startupCommand) => {
            const store = window.__store!
            const state = store.getState()
            const worktreeId = state.activeWorktreeId
            if (!worktreeId) {
              throw new Error('Missing managed Claude workspace')
            }
            const tab = state.createTab(worktreeId, undefined, undefined, {
              launchAgent: 'claude',
              pendingStartup: { command: startupCommand, launchAgent: 'claude' }
            })
            state.setActiveTab(tab.id)
            state.setActiveTabType('terminal', worktreeId)
          },
          nodeTerminalCommand([launcher])
        )
        await waitForActiveTerminalManager(orcaPage)
      }
      const ptyId = await waitForActivePanePtyId(orcaPage)
      try {
        if (!managed) {
          await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([launcher]))
        }
        await expect
          .poll(() =>
            orcaPage.evaluate(() => {
              const tabId = window.__store!.getState().activeTabId
              const manager = tabId && window.__paneManagers?.get(tabId)
              const pane = manager && manager.getActivePane()
              return Boolean(manager && pane && manager.hasWebglRenderer(pane.id))
            })
          )
          .toBe(acceleration === 'on')
        await waitForTerminalOutput(orcaPage, 'IMAGE_ACCEPTANCE_bytes', 30_000)
        expect(JSON.parse(readFileSync(gateReceipt, 'utf8'))).toEqual({
          flag: managed ? '1' : null
        })
        const screen = orcaPage.locator('.pane:visible .xterm-screen').first()
        const colors = async (name: string) => {
          const notice = orcaPage.getByRole('status', {
            name: 'Usage display is now compact',
            exact: true
          })
          if (await notice.isVisible()) {
            await notice.getByRole('button', { name: 'Got it', exact: true }).click()
          }
          const png = PNG.sync.read(await screen.screenshot({ path: testInfo.outputPath(name) }))
          const counts = { red: 0, blue: 0, green: 0, yellow: 0 }
          for (let i = 0; i < png.data.length; i += 4) {
            const [r, g, b] = png.data.subarray(i, i + 3)
            if (r > 220 && g < 60 && b < 60) {
              counts.red++
            }
            if (r < 60 && g > 60 && g < 100 && b > 220) {
              counts.blue++
            }
            if (r < 60 && g > 220 && b < 60) {
              counts.green++
            }
            if (r > 220 && g > 180 && g < 220 && b < 60) {
              counts.yellow++
            }
          }
          return counts
        }
        if (!managed) {
          await waitForTerminalOutput(orcaPage, 'SYNTHETIC_IMAGE_FALLBACK', 15_000)
          expect(await colors('automatic-fallback.png')).toEqual({
            red: 0,
            blue: 0,
            green: 0,
            yellow: 0
          })
          return
        }
        await expect
          .poll(
            async () => {
              const count = await colors('direct-bytes.png')
              return count.red > 1000 && count.blue > 1000
            },
            { timeout: 15_000 }
          )
          .toBe(true)
        await sendToTerminal(orcaPage, ptyId, '/image-acceptance file\r')
        await waitForTerminalOutput(orcaPage, 'IMAGE_ACCEPTANCE_STAGE_file', 15_000)
        await expect
          .poll(
            async () => {
              const count = await colors('host-file.png')
              return count.green > 1000 && count.yellow > 1000 && count.red < 50 && count.blue < 50
            },
            { timeout: 15_000 }
          )
          .toBe(true)
        await sendToTerminal(orcaPage, ptyId, '/image-acceptance clear\r')
        await waitForTerminalOutput(orcaPage, 'IMAGE_ACCEPTANCE_STAGE_clear', 15_000)
        await expect
          .poll(() => colors('cleared.png'), { timeout: 15_000 })
          .toEqual({ red: 0, blue: 0, green: 0, yellow: 0 })
      } finally {
        try {
          await orcaPage.evaluate((id) => window.api.pty.kill(id), ptyId)
        } finally {
          cleanup()
        }
      }
    })
  }
}
