import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@stablyai/playwright-test'
import { createRestartSession, attachRepoAndOpenTerminal } from './helpers/orca-restart'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { publishCatalogFixtureRelease } from './helpers/plugin-catalog-fixture-release'
import { capturePluginEvidence } from './helpers/plugin-evidence'
import { pluginManifestSchema } from '../../src/shared/plugins/plugin-manifest'

async function colors(line: Locator): Promise<number> {
  return line
    .locator('span')
    .evaluateAll(
      (spans) =>
        new Set(
          spans
            .filter((span) => !span.childElementCount && span.textContent?.trim())
            .map((span) => getComputedStyle(span).color)
        ).size
    )
}

async function openFile(
  page: Page,
  filePath: string,
  worktreeId: string,
  language: string,
  readOnly = false
): Promise<void> {
  await page.evaluate(
    ({ filePath, worktreeId, language, readOnly }) =>
      window.__store?.getState().openFile({
        filePath,
        relativePath: filePath.split(/[\\/]/).at(-1) ?? '',
        worktreeId,
        language,
        mode: 'edit',
        readOnly
      }),
    { filePath, worktreeId, language, readOnly }
  )
  await expect.poll(() => page.evaluate(() => window.__monacoEditorE2E?.filePath)).toBe(filePath)
}

test('installed syntax shows load, size and worker-budget recovery while preserving a healthy neighbor and user edits', async ({
  browserName: _browserName
}, testInfo) => {
  const fixture = await createPluginCatalogFixture({ syntaxPacks: true })
  const repository = join(fixture.root, 'repositories', 'orca-syntax-sample.git')
  const manifestPath = join(repository, 'orca-plugin.json')
  const manifest = pluginManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version: '1.1.0' }))
  await writeFile(
    join(repository, 'grammar.json'),
    JSON.stringify({
      scopeName: 'source.sample',
      patterns: [
        ...Array.from({ length: 80 }, (_, index) => ({
          match: `(?:a|aa|x${index})+$`,
          name: 'keyword.hostile'
        })),
        { match: '\\b(?:launch|recovered)\\b', name: 'keyword.control.sample' },
        { match: '\\b[0-9]+\\b', name: 'constant.numeric.sample' }
      ]
    })
  )
  await publishCatalogFixtureRelease(fixture, 'orca-syntax-sample', '1.1.0')
  await mkdir(join(fixture.root, 'workspace'))
  const workspace = await realpath(join(fixture.root, 'workspace'))
  const samplePath = join(workspace, 'program.orcasample')
  const hostilePath = join(workspace, 'hostile.orcasample')
  const largePath = join(workspace, 'large.typ')
  const readOnlyPath = join(workspace, 'readonly.typ')
  const healthyPath = join(workspace, 'healthy.typ')
  await writeFile(samplePath, 'launch 42\n')
  await writeFile(hostilePath, `${'a'.repeat(200_000)}!`)
  const largeText = '#let large = 12pt\n'.repeat(20_001)
  await writeFile(largePath, largeText)
  await writeFile(readOnlyPath, largeText)
  await writeFile(healthyPath, '#let healthy = 12pt\n')
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
    await expect(page.locator('[data-settings-section="plugins"]')).toBeVisible()
    await page.getByRole('switch', { name: 'Plugin system', exact: true }).click()
    const key = 'stablyai.orca-syntax-sample'
    const listing = page.locator(`[data-marketplace-plugin-key="${key}"]`)
    await listing.getByRole('button', { name: 'Install', exact: true }).click()
    await expect(listing.getByRole('button', { name: 'Update', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')

    const recovery = page.getByRole('status', { name: 'Highlighting paused', exact: true })
    const line = (text: string) =>
      page.locator('.monaco-editor .view-line').filter({ hasText: text }).first()
    const pluginDir = join(session.userDataDir, 'plugins', key)
    const hash = (await readFile(join(pluginDir, 'current'), 'utf8')).trim()
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error('Fixture current pointer is invalid')
    }
    const grammarPath = join(pluginDir, hash, 'grammar.json')
    const grammar = await readFile(grammarPath)
    await writeFile(
      grammarPath,
      JSON.stringify({
        scopeName: 'source.sample',
        patterns: [{ match: 'launch', name: 'keyword.changed' }]
      })
    )
    await openFile(page, samplePath, worktreeId, 'plaintext')
    await expect(recovery).toContainText('could not be loaded')
    await capturePluginEvidence(page, testInfo, 'syntax-rejected-valid-artifact', app)
    await writeFile(grammarPath, '{')
    await recovery.getByRole('button', { name: 'Retry highlighting', exact: true }).click()
    await expect(recovery).toContainText('could not be loaded')
    await capturePluginEvidence(page, testInfo, 'syntax-failed-load', app)
    await writeFile(grammarPath, grammar)
    await recovery.getByRole('button', { name: 'Retry highlighting', exact: true }).click()
    await expect(recovery).toBeHidden()
    await expect.poll(() => colors(line('launch 42'))).toBeGreaterThan(1)
    await capturePluginEvidence(page, testInfo, 'syntax-load-recovered', app)

    await openFile(page, healthyPath, worktreeId, 'typst')
    await expect.poll(() => colors(line('#let healthy'))).toBeGreaterThan(1)
    await openFile(page, hostilePath, worktreeId, 'plaintext')
    await page.getByRole('button', { name: 'Settings', exact: true }).click({ timeout: 1500 })
    const search = page.getByRole('textbox', { name: /Search settings/ })
    await expect(search).toBeVisible({ timeout: 1500 })
    await search.fill('appearance', { timeout: 1500 })
    await expect(search).toHaveValue('appearance', { timeout: 1500 })
    await page.keyboard.press('Escape')
    await expect(recovery).toContainText('took too long and was stopped', { timeout: 8000 })
    await capturePluginEvidence(page, testInfo, 'syntax-worker-budget', app)
    await recovery.getByRole('button', { name: 'Retry highlighting', exact: true }).click()
    await expect(recovery).toBeHidden()
    await expect(recovery).toContainText('took too long and was stopped', { timeout: 8000 })
    await page.locator('.monaco-editor').first().click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('launch recovered 42')
    await expect.poll(() => colors(line('launch recovered 42'))).toBeGreaterThan(1)
    await expect(recovery).toBeHidden()
    expect(await page.evaluate(() => window.__monacoEditorE2E?.snapshot().canUndo)).toBe(true)
    await capturePluginEvidence(page, testInfo, 'syntax-worker-recovered', app)

    await openFile(page, readOnlyPath, worktreeId, 'typst', true)
    await expect(recovery).toContainText('You can still read it')
    await page.locator('.monaco-editor').first().click()
    await page.keyboard.type('NOT_ALLOWED')
    expect(await page.evaluate(() => window.__monacoEditorE2E?.snapshot().valueLength)).toBe(
      largeText.length
    )
    expect(await readFile(readOnlyPath, 'utf8')).toBe(largeText)
    await capturePluginEvidence(page, testInfo, 'syntax-readonly-file-limit', app)
    const picker = page.getByRole('combobox', { name: 'Choose syntax', exact: true })
    await picker.click()
    await page.locator('[role="option"][data-value="plaintext"]').click()
    await expect(recovery).toBeHidden()
    await expect(picker).toHaveText('Plain text')
    await picker.click()
    await page.locator('[role="option"][data-value="auto"]').click()
    await expect(recovery).toContainText('exceeds the highlighting limit')

    await openFile(page, largePath, worktreeId, 'typst')
    await expect(recovery).toContainText('exceeds the highlighting limit')
    await capturePluginEvidence(page, testInfo, 'syntax-file-limit', app)
    await page.locator('.monaco-editor').first().click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('#let recovered = 12pt')
    await expect.poll(() => colors(line('#let recovered'))).toBeGreaterThan(1)
    await expect(recovery).toBeHidden()
    expect(await page.evaluate(() => window.__monacoEditorE2E?.snapshot().canUndo)).toBe(true)
    await capturePluginEvidence(page, testInfo, 'syntax-file-limit-recovered', app)
    await openFile(page, healthyPath, worktreeId, 'typst')
    await expect.poll(() => colors(line('#let healthy'))).toBeGreaterThan(1)
    await expect(recovery).toBeHidden()
    expect(await readFile(healthyPath, 'utf8')).toBe('#let healthy = 12pt\n')
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
