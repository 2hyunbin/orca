import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ElectronApplication } from '@stablyai/playwright-test'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { capturePluginEvidence, getPluginEvidenceDirectory } from './helpers/plugin-evidence'
import {
  startPluginViewerChildFault,
  capturePluginViewerChildFaultEvidence
} from './helpers/plugin-viewer-frame-fault-evidence'

async function parserText(app: ElectronApplication, url: string | null): Promise<string> {
  return app.evaluate(async ({ webContents }, url) => {
    const guest = webContents.getAllWebContents().find((item) => item.getURL() === url)
    const frame = guest?.mainFrame.framesInSubtree.find((item) => item !== guest.mainFrame)
    const value = frame ? await frame.executeJavaScript('document.body.innerText') : ''
    return typeof value === 'string' ? value : ''
  }, url)
}

test('installed parsers lose memory, loop and flood authority while the host recovers and their API stays closed', async ({
  browserName: _browserName
}, testInfo) => {
  test.setTimeout(120_000)
  const fixture = await createPluginCatalogFixture({ viewerPack: true, hostileViewers: true })
  const directory = join(fixture.root, 'workspace')
  await mkdir(directory)
  const workspace = await realpath(directory)
  await fixture.runGit(workspace, ['init', '--quiet'])
  const filePath = join(workspace, 'hostile.viewer-fixture')
  await writeFile(filePath, 'memory')
  const healthyPath = join(workspace, 'healthy.viewer-fixture')
  await writeFile(healthyPath, 'safe')
  const session = createRestartSession(testInfo, fixture.gitEnvironment)
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch()
    const { page, app } = launched
    const worktreeId = await attachRepoAndOpenTerminal(page, workspace)
    await page.evaluate(() => {
      window.__store!.getState().openSettingsTarget({ pane: 'plugins', repoId: null })
      window.__store!.getState().openSettingsPage()
    })
    const feature = page.getByRole('switch', { name: 'Plugin system' })
    if (!(await feature.isChecked())) {
      await feature.click()
    }
    await page.getByRole('combobox', { name: 'Plugin type' }).click()
    await page.getByRole('option', { name: 'File viewers' }).click()
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
    await page.keyboard.press('Escape')
    const split = await page.evaluate(
      ({ worktreeId, filePath, healthyPath }) => {
        const state = window.__store!.getState()
        const left = state.ensureWorktreeRootGroup(worktreeId)
        state.openFile(
          {
            filePath: healthyPath,
            relativePath: 'healthy.viewer-fixture',
            worktreeId,
            mode: 'edit',
            language: 'plaintext'
          },
          { preview: false, targetGroupId: left }
        )
        const right = state.createEmptySplitGroup(worktreeId, left, 'right')
        if (!right) {
          throw new Error('Viewer split unavailable')
        }
        state.openFile(
          {
            filePath,
            relativePath: 'hostile.viewer-fixture',
            worktreeId,
            mode: 'edit',
            language: 'plaintext'
          },
          { preview: false, targetGroupId: right }
        )
        return { left, right }
      },
      { worktreeId, filePath, healthyPath }
    )
    const surface = page.locator(
      `[data-tab-group-body-id="${split.right}"] [data-plugin-file-viewer]`
    )
    const healthy = page.locator(
      `[data-tab-group-body-id="${split.left}"] [data-plugin-file-viewer]`
    )
    const alert = surface.getByRole('alert')
    const attackedPids = new Set<number>()
    let observedPeakBytes = 0
    await expect
      .poll(
        async () => {
          const url = await surface
            .locator('webview')
            .evaluateAll((items) => items[0]?.getAttribute('src') ?? null)
          const snapshot = await app.evaluate(({ app, webContents }, url) => {
            const guest = webContents.getAllWebContents().find((item) => item.getURL() === url)
            const pids = [
              ...new Set(guest?.mainFrame.framesInSubtree.map((frame) => frame.osProcessId) ?? [])
            ]
            const bytes = app
              .getAppMetrics()
              .filter((metric) => pids.includes(metric.pid))
              .reduce((sum, metric) => sum + metric.memory.workingSetSize * 1024, 0)
            return { pids, bytes }
          }, url)
          snapshot.pids.forEach((pid) => attackedPids.add(pid))
          observedPeakBytes = Math.max(observedPeakBytes, snapshot.bytes)
          return (await alert.allTextContents()).join(' ')
        },
        { timeout: 20_000, intervals: [100] }
      )
      .toContain('resource limits')
    expect(attackedPids.size).toBeGreaterThanOrEqual(2)
    await expect
      .poll(() =>
        app.evaluate(
          ({ webContents }) =>
            webContents
              .getAllWebContents()
              .filter((item) => item.getURL().startsWith('orca-plugin-viewer://')).length
        )
      )
      .toBe(1)
    await expect
      .poll(() =>
        app.evaluate(
          ({ app }, pids) =>
            app.getAppMetrics().filter((metric) => pids.includes(metric.pid)).length,
          [...attackedPids]
        )
      )
      .toBe(0)
    await expect
      .poll(async () => parserText(app, await healthy.locator('webview').getAttribute('src')))
      .toContain('Recovered document')
    expect(await page.evaluate(() => window.__store!.getState().activeWorktreeId)).toBe(worktreeId)
    await capturePluginEvidence(page, testInfo, 'viewer-hostile-memory-limit', app)
    const recover = async (): Promise<void> => {
      await writeFile(filePath, 'safe')
      await surface.getByRole('button', { name: 'Retry', exact: true }).click()
      await expect
        .poll(async () => parserText(app, await surface.locator('webview').getAttribute('src')))
        .toContain('Recovered document')
      await expect(alert).toBeHidden()
    }
    await recover()
    await capturePluginEvidence(page, testInfo, 'viewer-hostile-memory-recovered', app)
    for (const [mode, message] of [
      ['idle-loop', 'stopped responding'],
      ['flood', 'invalid content']
    ]) {
      await writeFile(filePath, mode)
      await surface.getByRole('button', { name: 'Reload viewer', exact: true }).click()
      await expect(alert).toContainText(message, { timeout: 10_000 })
      await expect
        .poll(async () => parserText(app, await healthy.locator('webview').getAttribute('src')))
        .toContain('Recovered document')
      await capturePluginEvidence(page, testInfo, `viewer-hostile-${mode}`, app)
      await recover()
    }
    const logPath = testInfo.outputPath('viewer-api-netlog.json')
    const frameFaultBefore = await startPluginViewerChildFault(
      app,
      await surface.locator('webview').getAttribute('src')
    )
    await expect(alert).toContainText('stopped responding', { timeout: 10_000 })
    await expect
      .poll(async () => parserText(app, await healthy.locator('webview').getAttribute('src')))
      .toContain('Recovered document')
    await expect
      .poll(() =>
        app.evaluate(
          ({ app }, pids) =>
            app.getAppMetrics().filter((metric) => pids.includes(metric.pid)).length,
          frameFaultBefore.targetPids
        )
      )
      .toBe(0)
    await capturePluginViewerChildFaultEvidence(app, testInfo, frameFaultBefore)
    await capturePluginEvidence(page, testInfo, 'viewer-child-frame-watchdog', app)
    await recover()
    await app.evaluate(async ({ session }, path) => {
      await session.defaultSession.netLog.startLogging(path, { captureMode: 'everything' })
    }, logPath)
    try {
      await writeFile(filePath, 'api')
      await surface.getByRole('button', { name: 'Reload viewer', exact: true }).click()
      await expect
        .poll(async () => parserText(app, await surface.locator('webview').getAttribute('src')))
        .toContain('XMLHttpRequest: blocked')
      const text = await parserText(app, await surface.locator('webview').getAttribute('src'))
      for (const key of [
        'document',
        'process',
        'require',
        'Buffer',
        'orcaFileViewerHost',
        'fetch',
        'WebSocket',
        'WebTransport',
        'Worker',
        'SharedWorker',
        'importScripts'
      ]) {
        expect(text).toContain(`${key}: undefined`)
      }
      expect(text).toContain('indexedDB: blocked')
      expect(text).toContain('caches: blocked')
      await capturePluginEvidence(page, testInfo, 'viewer-installed-api-boundary', app)
    } finally {
      await app.evaluate(async ({ session }) => {
        await session.defaultSession.netLog.stopLogging()
      })
    }
    const log = JSON.parse(await readFile(logPath, 'utf8'))
    const ownEvents = log.events.filter((event: { params?: unknown }) =>
      JSON.stringify(event.params ?? {}).includes('orca-viewer-security-probe.invalid')
    )
    expect(ownEvents).toHaveLength(0)
    const proof = {
      installedThroughCatalog: true,
      hiddenCapabilities: true,
      opaqueStorageDenied: true,
      attemptedHost: 'orca-viewer-security-probe.invalid',
      matchingNetworkEvents: ownEvents.length,
      observedPeakBytes,
      retiredProcessCount: attackedPids.size,
      retiredChildFaultProcessCount: frameFaultBefore.targetPids.length,
      healthySplitPreserved: true
    }
    const proofPath = testInfo.outputPath('viewer-installed-boundary.json')
    await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`)
    await testInfo.attach('viewer-installed-boundary', {
      path: proofPath,
      contentType: 'application/json'
    })
    const evidence = getPluginEvidenceDirectory()
    await writeFile(
      join(evidence, 'viewer-installed-boundary.json'),
      `${JSON.stringify(proof, null, 2)}\n`
    )
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
