import { sendViewerInput } from './helpers/plugin-viewer-input'
import { cp, mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ElectronApplication } from '@stablyai/playwright-test'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { capturePluginEvidence } from './helpers/plugin-evidence'
import { openFileExplorer } from './helpers/file-explorer'

async function inViewer(app: ElectronApplication, script: string): Promise<unknown> {
  return app.evaluate(async ({ webContents }, script) => {
    const guest = webContents
      .getAllWebContents()
      .find((contents) => contents.getURL().startsWith('orca-plugin-viewer://'))
    const frame = guest?.mainFrame.framesInSubtree.find(
      (candidate) => candidate !== guest.mainFrame
    )
    if (!frame || !(await frame.executeJavaScript('Boolean(document.body)'))) {
      return null
    }
    return frame.executeJavaScript(script)
  }, script)
}

async function prepareCopyProof(app: ElectronApplication): Promise<void> {
  await inViewer(
    app,
    `window.__viewerCopyProof = null; document.addEventListener('copy', event => {
    const value = document.activeElement;
    window.__viewerCopyProof = { text: value?.value?.slice(value.selectionStart, value.selectionEnd), trusted: event.isTrusted };
    event.preventDefault();
  }, { once: true });`
  )
}

test('installs independent XLSX and STL releases and opens real binary files through the generic viewer API', async ({
  browserName: _browserName
}, testInfo) => {
  const fixture = await createPluginCatalogFixture({ formatViewers: true })
  const directory = join(fixture.root, 'workspace')
  await mkdir(directory)
  const workspace = await realpath(directory)
  await cp(join(process.cwd(), 'tests', 'e2e', 'fixtures', 'plugin-format-corpus'), workspace, {
    recursive: true
  })
  await fixture.runGit(workspace, ['init', '--quiet'])
  const session = createRestartSession(testInfo, fixture.gitEnvironment)
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch()
    const { page, app } = launched
    const worktreeId = await attachRepoAndOpenTerminal(page, workspace)
    await page.evaluate(() => {
      window.__store?.getState().openSettingsTarget({ pane: 'plugins', repoId: null })
      window.__store?.getState().openSettingsPage()
    })
    const enabled = page.getByRole('switch', { name: 'Plugin system' })
    if (!(await enabled.isChecked())) {
      await enabled.click()
    }
    await page.getByRole('combobox', { name: 'Plugin type' }).click()
    await page.getByRole('option', { name: 'File viewers' }).click()
    await expect(
      page.locator('[data-marketplace-plugin-key="stablyai.orca-viewer-xlsx"]')
    ).toContainText('XLSX tables')
    await expect(
      page.locator('[data-marketplace-plugin-key="stablyai.orca-viewer-stl"]')
    ).toContainText('STL models')
    await capturePluginEvidence(page, testInfo, 'real-format-catalog')
    for (const format of [
      { id: 'xlsx', title: 'XLSX tables' },
      { id: 'stl', title: 'STL models' }
    ]) {
      await page.getByRole('tab', { name: /^All/ }).click()
      const listing = page.locator(
        `[data-marketplace-plugin-key="stablyai.orca-viewer-${format.id}"]`
      )
      await listing.getByRole('button', { name: 'Install', exact: true }).click()
      const preview = page.getByRole('dialog', { name: format.title, exact: true })
      await expect(preview).toContainText('can read only the file you open with it')
      await preview.getByRole('button', { name: 'Install plugin', exact: true }).click()
      const consent = page.getByRole('dialog', { name: 'Review plugin', exact: true })
      await expect(consent).toContainText('cannot save changes or access the network')
      await consent.getByRole('button', { name: 'Enable plugin', exact: true }).click()
      await expect(consent).toBeHidden()
      await page.getByRole('tab', { name: /^Installed/ }).click()
      await expect(
        page.locator(`[data-plugin-key="stablyai.orca-viewer-${format.id}"]`)
      ).toContainText('Enabled')
    }
    await capturePluginEvidence(page, testInfo, 'real-format-installed')
    await page.keyboard.press('Escape')
    await openFileExplorer(page)
    const workbook = page
      .locator('[data-file-explorer-row]')
      .filter({ has: page.getByText('ProducedBudget.xlsx', { exact: true }) })
    await expect(workbook).toBeVisible()
    await workbook.dblclick()
    await expect(page.locator('[data-plugin-file-viewer]')).toBeVisible()
    await expect
      .poll(() => inViewer(app, 'document.body.innerText'))
      .toContain('Producer-generated budget')
    await capturePluginEvidence(page, testInfo, 'viewer-automatic-xlsx', app)
    const open = async (filename: string, viewer: string): Promise<void> => {
      await page.evaluate(
        ({ filePath, filename, worktreeId }) => {
          window.__store?.getState().openFile(
            {
              filePath,
              relativePath: filename,
              worktreeId,
              language: 'plaintext',
              mode: 'edit'
            },
            { fileViewer: 'core' }
          )
        },
        { filePath: join(workspace, filename), filename, worktreeId }
      )
      await page.getByRole('button', { name: 'Open with', exact: true }).click()
      await page.getByRole('option').filter({ hasText: viewer }).click()
      await page.getByRole('button', { name: 'Open once', exact: true }).click()
      await expect(page.locator('[data-plugin-file-viewer]')).toBeVisible()
      await expect(page.getByText('Read only', { exact: true })).toBeVisible()
    }
    const text = (): Promise<unknown> => inViewer(app, 'document.body.innerText')
    await open('ProducedBudget.xlsx', 'XLSX tables')
    await expect.poll(text).toContain('Producer-generated budget')
    await expect.poll(text).toContain('Revenue – 世界')
    await expect.poll(text).toContain('2026-10-08')
    await expect.poll(text).toContain('Cached value unavailable')
    await capturePluginEvidence(page, testInfo, 'xlsx-real-producer-workbook', app)
    await open('Budget.xlsx', 'XLSX tables')
    await expect.poll(text).toContain('Team budget')
    await expect.poll(text).toContain('12500.50')
    await expect.poll(text).toContain('3750.50')
    await expect.poll(text).toContain('12.50%')
    await expect.poll(text).toContain('<script>Literal cell text</script>')
    await expect.poll(() => inViewer(app, 'document.querySelectorAll("img,iframe").length')).toBe(0)
    await capturePluginEvidence(page, testInfo, 'xlsx-real-worksheet', app)
    await inViewer(
      app,
      `document.querySelector('td[title^="Saved formula result"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
    )
    await expect.poll(text).toContain('Saved formula result. Formulas are not calculated.')
    await expect
      .poll(() => inViewer(app, 'Boolean(document.querySelector("textarea[readonly]"))'))
      .toBe(true)
    await inViewer(
      app,
      `Promise.all(document.getAnimations().filter(animation => animation.effect.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))`
    )
    await capturePluginEvidence(page, testInfo, 'xlsx-real-cached-cell-inspection', app)
    await inViewer(
      app,
      `window.__keyboardProof = []; document.addEventListener('keydown', event => window.__keyboardProof.push({ key: event.key, target: event.target?.tagName, trusted: event.isTrusted }));`
    )
    await sendViewerInput(app, { kind: 'key', key: 'Escape' })
    await expect
      .poll(() => inViewer(app, 'document.activeElement?.getAttribute("role")'))
      .toBe('grid')
    const focusProof = await inViewer(
      app,
      `({focusedRole: document.activeElement?.getAttribute('role'), popoverOpen: Boolean(document.querySelector('[data-slot="popover-content"]')), events: window.__keyboardProof})`
    )
    expect(focusProof).toEqual({
      focusedRole: 'grid',
      popoverOpen: false,
      events: [{ key: 'Escape', target: 'TEXTAREA', trusted: true }]
    })
    await testInfo.attach('viewer-keyboard-focus', {
      body: JSON.stringify(focusProof),
      contentType: 'application/json'
    })
    await inViewer(app, 'document.querySelector("[role=combobox]").click()')
    await expect.poll(text).toContain('Notes')
    await inViewer(
      app,
      `Array.from(document.querySelectorAll('[role=option]')).find(item => item.textContent === 'Notes').click()`
    )
    await expect.poll(text).toContain('Notes from the second worksheet')
    await capturePluginEvidence(page, testInfo, 'xlsx-real-second-sheet', app)
    await open('Dense.xlsx', 'XLSX tables')
    await expect.poll(text).toContain('Forecast row 1, column 1')
    const cellCount = await inViewer(app, 'document.querySelectorAll("td").length')
    expect(typeof cellCount).toBe('number')
    expect(Number(cellCount)).toBeLessThan(1000)
    expect(Number(cellCount)).toBeGreaterThan(20)
    const fullValue = await inViewer(app, 'document.querySelector("td").textContent')
    expect(String(fullValue).length).toBeGreaterThan(160)
    await inViewer(app, 'document.querySelector("[role=grid]").focus()')
    await sendViewerInput(app, { kind: 'key', key: 'Enter' })
    await expect
      .poll(() => inViewer(app, 'document.querySelector("textarea")?.value'))
      .toBe(fullValue)
    await prepareCopyProof(app)
    await sendViewerInput(app, { kind: 'click-copy' })
    await expect
      .poll(() => inViewer(app, 'window.__viewerCopyProof'))
      .toEqual({ text: fullValue, trusted: true })
    await expect.poll(text).toContain('Copied')
    await inViewer(
      app,
      `Promise.all(document.getAnimations().filter(animation => animation.effect.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))`
    )
    await capturePluginEvidence(page, testInfo, 'xlsx-real-long-cell-copy', app)
    await sendViewerInput(app, { kind: 'key', key: 'Escape' })
    await expect
      .poll(() => inViewer(app, 'document.activeElement?.getAttribute("role")'))
      .toBe('grid')
    await sendViewerInput(app, { kind: 'key', key: 'PageDown' })
    await expect
      .poll(() =>
        inViewer(
          app,
          'Number(document.querySelector("[aria-selected=true]")?.parentElement.getAttribute("aria-rowindex"))'
        )
      )
      .toBeGreaterThan(10)
    const edgeModifier = process.platform === 'darwin' ? 'meta' : 'control'
    await sendViewerInput(app, { kind: 'key', key: 'End', modifiers: [edgeModifier] })
    await expect
      .poll(() => inViewer(app, 'document.querySelector("[aria-selected=true]")?.id'))
      .toBe('viewer-cell-199-23')
    await expect.poll(text).toContain('Forecast row 200, column 24')
    await expect
      .poll(() => inViewer(app, 'document.activeElement?.getAttribute("role")'))
      .toBe('grid')
    await expect
      .poll(() =>
        inViewer(
          app,
          `(() => { const cell = document.querySelector('[aria-selected=true]').getBoundingClientRect(); const pane = document.querySelector('[data-viewer-scroll]').getBoundingClientRect(); return cell.left >= pane.left + 48 - 1 && cell.top >= pane.top + 28 - 1 && cell.right <= pane.right + 1 && cell.bottom <= pane.bottom + 1; })()`
        )
      )
      .toBe(true)
    await expect.poll(text).not.toContain('Copied')
    await capturePluginEvidence(page, testInfo, 'xlsx-real-keyboard-last-cell', app)
    await expect
      .poll(() =>
        inViewer(
          app,
          `(() => { const row = document.querySelector('[aria-selected=true]').parentElement.querySelector('[role=rowheader]'); const pane = document.querySelector('[data-viewer-scroll]').getBoundingClientRect(); const rect = row.getBoundingClientRect(); return row.textContent === '200' && rect.left >= pane.left - 1 && rect.right <= pane.left + 48 + 1; })()`
        )
      )
      .toBe(true)
    for (let step = 0; step < 7; step++) {
      await sendViewerInput(app, { kind: 'key', key: 'ArrowLeft' })
    }
    await expect
      .poll(() => inViewer(app, 'document.querySelector("[aria-selected=true]")?.id'))
      .toBe('viewer-cell-199-16')
    await expect
      .poll(() =>
        inViewer(
          app,
          `(() => { const cell = document.querySelector('[aria-selected=true]').getBoundingClientRect(); const pane = document.querySelector('[data-viewer-scroll]').getBoundingClientRect(); return cell.left >= pane.left + 48 - 1 && cell.right <= pane.right + 1; })()`
        )
      )
      .toBe(true)
    await expect
      .poll(() => inViewer(app, 'document.querySelector("[aria-selected=true]")?.textContent'))
      .toContain('Forecast row 200, column 17')
    const keyboardValue = await inViewer(
      app,
      'document.querySelector("[aria-selected=true]")?.textContent'
    )
    await prepareCopyProof(app)
    await sendViewerInput(app, { kind: 'key', key: 'c', modifiers: [edgeModifier] })
    await expect
      .poll(() => inViewer(app, 'window.__viewerCopyProof'))
      .toEqual({ text: keyboardValue, trusted: true })
    await expect
      .poll(() => inViewer(app, 'document.activeElement?.getAttribute("role")'))
      .toBe('grid')
    await expect.poll(text).toContain('Copied')
    await inViewer(
      app,
      `Promise.all(document.getAnimations().filter(animation => animation.effect.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))`
    )
    await capturePluginEvidence(page, testInfo, 'xlsx-real-grid-cell-copy', app)
    await sendViewerInput(app, { kind: 'key', key: 'Home', modifiers: [edgeModifier] })
    await expect
      .poll(() => inViewer(app, 'document.querySelector("[aria-selected=true]")?.id'))
      .toBe('viewer-cell-0-0')
    await inViewer(app, 'document.querySelector("[data-viewer-scroll]").scrollLeft = 160 * 16')
    await expect.poll(text).toContain('Forecast row 1, column 17')
    await capturePluginEvidence(page, testInfo, 'xlsx-real-dense-horizontal-scroll', app)
    await open('Malformed.xlsx', 'XLSX tables')
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    await expect(page.getByRole('alert')).toContainText(
      'does not support this file’s format or features'
    )
    await capturePluginEvidence(page, testInfo, 'xlsx-real-malformed-recovery', app)
    await cp(
      join(process.cwd(), 'tests', 'e2e', 'fixtures', 'plugin-format-corpus', 'Budget.xlsx'),
      join(workspace, 'Malformed.xlsx')
    )
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect.poll(text).toContain('Team budget')
    await capturePluginEvidence(page, testInfo, 'xlsx-real-retry-recovered', app)
    await open('Pyramid.stl', 'STL models')
    await expect.poll(() => inViewer(app, 'Boolean(document.querySelector("canvas"))')).toBe(true)
    const centerPixel = (): Promise<unknown> =>
      inViewer(
        app,
        'Array.from(document.querySelector("canvas").getContext("2d").getImageData(256,256,1,1).data)'
      )
    await expect.poll(centerPixel).toEqual([241, 241, 241, 255])
    await capturePluginEvidence(page, testInfo, 'stl-real-binary-model', app)
    await inViewer(app, 'document.querySelector(`[aria-label="Zoom in"]`).click()')
    await expect.poll(text).toContain('125%')
    await inViewer(
      app,
      'document.querySelector("canvas").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}))'
    )
    await expect.poll(centerPixel).not.toEqual([241, 241, 241, 255])
    await capturePluginEvidence(page, testInfo, 'stl-real-orbit-zoom', app)
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
