import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@stablyai/playwright-test'
import { createRestartSession } from './helpers/orca-restart'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { capturePluginEvidence } from './helpers/plugin-evidence'

test('the production package retires hostile parser processes and recovers repeatedly through visible controls', async ({
  browserName: _browserName
}, testInfo) => {
  const executablePath = process.env.ORCA_PHASE_O_1_PACKAGED_EXECUTABLE
  test.skip(!executablePath, 'Set ORCA_PHASE_O_1_PACKAGED_EXECUTABLE to a built production package')
  test.setTimeout(120_000)
  const fixture = await createPluginCatalogFixture({ viewerPack: true, hostileViewers: true })
  const directory = join(fixture.root, 'Documents')
  await mkdir(directory)
  const folderPath = await realpath(directory)
  const filePath = join(folderPath, 'Recovery.viewer-fixture')
  await writeFile(filePath, 'safe')
  const session = createRestartSession(testInfo, fixture.gitEnvironment)
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch({
      executablePath,
      waitForStore: false,
      extraEnv: { NODE_ENV: 'production' }
    })
    const { page, app } = launched
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    expect(await page.evaluate(() => Boolean(window.__store))).toBe(false)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    const feature = page.getByRole('switch', { name: 'Plugin system', exact: true })
    if (!(await feature.isChecked())) {
      await feature.click()
    }
    await page
      .locator('[data-marketplace-plugin-key="stablyai.orca-viewer-sample"]')
      .getByRole('button', { name: 'Install', exact: true })
      .click()
    await page
      .getByRole('dialog', { name: 'Sample file viewer', exact: true })
      .getByRole('button', { name: 'Install plugin', exact: true })
      .click()
    await page
      .getByRole('dialog', { name: 'Review plugin', exact: true })
      .getByRole('button', { name: 'Enable plugin', exact: true })
      .click()
    await expect(page.getByRole('dialog', { name: 'Review plugin', exact: true })).toBeHidden()
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    await page.evaluate(async (folderPath) => {
      const group = await window.api.projectGroups.create({
        name: 'Parser recovery',
        parentPath: folderPath
      })
      await window.api.folderWorkspaces.create({
        projectGroupId: group.id,
        name: 'Recovery folder',
        folderPath
      })
    }, folderPath)
    await page.getByText('Recovery folder', { exact: true }).click()
    const explorer = page.getByRole('button', { name: /^Explorer/ })
    if (!(await explorer.isVisible())) {
      await page.getByRole('button', { name: 'Toggle right sidebar', exact: true }).click()
    }
    await explorer.click()
    await page
      .locator('[data-file-explorer-row]')
      .filter({ has: page.getByText('Recovery.viewer-fixture', { exact: true }) })
      .dblclick()
    const viewer = page.locator('[data-plugin-file-viewer]:visible')
    const text = async (): Promise<string> => {
      const url = await viewer.locator('webview').getAttribute('src')
      return app.evaluate(async ({ webContents }, url) => {
        const guest = webContents.getAllWebContents().find((item) => item.getURL() === url)
        const frame = guest?.mainFrame.framesInSubtree.find((item) => item !== guest.mainFrame)
        const value = frame ? await frame.executeJavaScript('document.body.innerText') : ''
        return typeof value === 'string' ? value : ''
      }, url)
    }
    await expect.poll(text).toContain('Recovered document')
    const rounds: {
      round: number
      mode: string
      peakSampledBytes: number
      retiredPids: number[]
    }[] = []
    for (let round = 1; round <= 2; round += 1) {
      for (const [mode, message] of [
        ['memory', 'resource limits'],
        ['idle-loop', 'stopped responding'],
        ['flood', 'invalid content']
      ]) {
        await writeFile(filePath, mode)
        await viewer.getByRole('button', { name: 'Reload viewer', exact: true }).click()
        const pids = new Set<number>()
        let peakSampledBytes = 0
        await expect
          .poll(
            async () => {
              const url = await viewer
                .locator('webview')
                .evaluateAll((items) => items[0]?.getAttribute('src') ?? null)
              const sample = await app.evaluate(({ app, webContents }, url) => {
                const guest = webContents.getAllWebContents().find((item) => item.getURL() === url)
                const pids = [
                  ...new Set(
                    guest?.mainFrame.framesInSubtree.map((frame) => frame.osProcessId) ?? []
                  )
                ]
                return {
                  pids,
                  bytes: app
                    .getAppMetrics()
                    .filter((metric) => pids.includes(metric.pid))
                    .reduce((sum, metric) => sum + metric.memory.workingSetSize * 1024, 0)
                }
              }, url)
              sample.pids.forEach((pid) => pids.add(pid))
              peakSampledBytes = Math.max(peakSampledBytes, sample.bytes)
              return (await viewer.getByRole('alert').allTextContents()).join(' ')
            },
            { timeout: 20_000, intervals: [100] }
          )
          .toContain(message)
        expect(pids.size).toBeGreaterThanOrEqual(2)
        expect(peakSampledBytes).toBeGreaterThan(0)
        await expect
          .poll(() =>
            app.evaluate(
              ({ app }, pids) =>
                app.getAppMetrics().filter((metric) => pids.includes(metric.pid)).length,
              [...pids]
            )
          )
          .toBe(0)
        rounds.push({ round, mode, peakSampledBytes, retiredPids: [...pids] })
        if (round === 1) {
          await capturePluginEvidence(page, testInfo, `packaged-parser-${mode}`, app)
        }
        const usageNotice = page.getByRole('status', { name: 'Usage is now compact', exact: true })
        if (await usageNotice.isVisible()) {
          await usageNotice.getByRole('button', { name: 'Dismiss', exact: true }).click()
          await expect(usageNotice).toHaveCount(0)
        }
        await page.getByRole('button', { name: 'Settings', exact: true }).click()
        await expect(page.getByRole('textbox', { name: /Search settings/ })).toBeVisible()
        await page.getByRole('button', { name: 'Back to app', exact: true }).click()
        await writeFile(filePath, 'safe')
        await viewer.getByRole('button', { name: 'Retry', exact: true }).click()
        await expect.poll(text).toContain('Recovered document')
        await expect(viewer.getByRole('alert')).toBeHidden()
      }
    }
    await capturePluginEvidence(page, testInfo, 'packaged-parser-repeated-recovery', app)
    expect(await page.evaluate(() => Boolean(window.__store))).toBe(false)
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      )
    ).toBe(false)
    const proof = `${JSON.stringify({ scope: 'production macOS arm64 package; sampled metrics', rounds }, null, 2)}\n`
    const evidencePath = testInfo.outputPath('packaged-parser-recovery.json')
    await writeFile(evidencePath, proof)
    await testInfo.attach('packaged-parser-recovery', {
      path: evidencePath,
      contentType: 'application/json'
    })
    await writeFile(
      join(process.cwd(), '.tmp', 'phase-o-1', 'evidence', 'packaged-parser-recovery.json'),
      proof
    )
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
