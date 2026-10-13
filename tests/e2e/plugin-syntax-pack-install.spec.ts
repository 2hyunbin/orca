import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@stablyai/playwright-test'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { capturePluginEvidence } from './helpers/plugin-evidence'
import { publishSyntaxFixtureUpdate } from './helpers/plugin-syntax-release-fixture'

async function openPlugins(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__store?.getState().openSettingsTarget({ pane: 'plugins', repoId: null })
    window.__store?.getState().openSettingsPage()
  })
  await expect(page.locator('[data-settings-section="plugins"]')).toBeVisible()
}

async function install(page: Page, key: string, name: string): Promise<void> {
  await page.getByRole('tab', { name: /^All/ }).click()
  const listing = page.locator(`[data-marketplace-plugin-key="${key}"]`)
  await expect(listing).toContainText(name)
  await listing.getByRole('button', { name: 'Install', exact: true }).click()
  await expect(listing.getByRole('button', { name: 'Update', exact: true })).toBeVisible()
  await expect(listing.getByRole('button', { name: 'Update', exact: true })).toBeEnabled()
  await expect(page.getByRole('dialog', { name: 'Review plugin', exact: true })).toHaveCount(0)
}

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

async function wordColor(line: Locator, word: string): Promise<string> {
  return line.locator('span').evaluateAll((spans, word) => {
    const matched = spans.find(
      (span) => !span.childElementCount && span.textContent?.trim().startsWith(word)
    )
    return matched ? getComputedStyle(matched).color : ''
  }, word)
}

test('real catalog-installed data syntax packs color files and visible inline diffs, and disable immediately', async ({
  browserName: _browserName
}, testInfo) => {
  const fixture = await createPluginCatalogFixture({ syntaxPacks: true, syntaxConflict: true })
  const directory = join(fixture.root, 'workspace')
  await mkdir(directory)
  const workspace = await realpath(directory)
  const typstPath = join(workspace, 'document.typst')
  await writeFile(
    join(workspace, 'document.typst'),
    '/* opens\n#let hidden = 12pt\n*/\n#let visible = 12pt\n'
  )
  const samplePath = join(workspace, 'program.orcasample')
  await writeFile(samplePath, 'launch "original" 42\n')
  await fixture.runGit(workspace, ['init', '--quiet'])
  await fixture.runGit(workspace, ['add', '--all'])
  await fixture.runGit(workspace, [
    '-c',
    'user.name=Orca Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'syntax fixture'
  ])
  const session = createRestartSession(testInfo, fixture.gitEnvironment)
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch()
    const { page } = launched
    const worktreeId = await attachRepoAndOpenTerminal(page, workspace)
    await openPlugins(page)
    const feature = page.getByRole('switch', { name: 'Plugin system' })
    if (!(await feature.isChecked())) {
      await feature.click()
    }
    await install(page, 'stablyai.orca-syntax-typst', 'Typst syntax')
    await install(page, 'stablyai.orca-syntax-sample', 'Sample syntax')
    await page.getByRole('tab', { name: /^Installed/ }).click()
    await expect(page.locator('[data-plugin-key="stablyai.orca-syntax-typst"]')).toContainText(
      'Enabled'
    )
    await capturePluginEvidence(page, testInfo, 'syntax-installed-packs')
    await page.keyboard.press('Escape')
    await page.evaluate(
      ({ typstPath, worktreeId }) => {
        window.__store?.getState().openFile({
          filePath: typstPath,
          relativePath: 'document.typst',
          worktreeId,
          language: 'plaintext',
          mode: 'edit',
          readOnly: true
        })
      },
      { typstPath, worktreeId }
    )
    const editor = page.locator('.monaco-editor').first()
    await expect(editor).toBeVisible()
    const visible = editor.locator('.view-line').filter({ hasText: '#let visible' })
    const hidden = editor.locator('.view-line').filter({ hasText: '#let hidden' })
    const conflictPicker = page.getByRole('combobox', { name: 'Choose syntax', exact: true })
    await expect(conflictPicker).toHaveText(/Choose syntax/)
    await expect.poll(() => colors(visible)).toBe(1)
    await conflictPicker.click()
    await expect(
      page.getByText('Several installed packs match this file. Choose the syntax to use.', {
        exact: true
      })
    ).toBeVisible()
    await capturePluginEvidence(page, testInfo, 'syntax-conflict-picker')
    await page.getByRole('option').filter({ hasText: 'Typst syntax' }).click()
    await expect.poll(() => colors(visible)).toBeGreaterThan(1)
    await expect.poll(() => colors(hidden)).toBe(1)
    await capturePluginEvidence(page, testInfo, 'syntax-installed-readonly')
    await page.evaluate(
      ({ worktreeId, samplePath }) => {
        window.__store?.getState().openFile({
          filePath: samplePath,
          relativePath: 'program.orcasample',
          worktreeId,
          language: 'plaintext',
          mode: 'edit'
        })
      },
      { worktreeId, samplePath }
    )
    const sampleLine = page
      .locator('.monaco-editor .view-line')
      .filter({ hasText: 'launch "original"' })
    await expect(sampleLine).toBeVisible()
    await expect.poll(() => colors(sampleLine)).toBeGreaterThan(1)
    await capturePluginEvidence(page, testInfo, 'syntax-installed-editor')
    const picker = page.getByRole('combobox', { name: 'Choose syntax', exact: true })
    await picker.click()
    await expect(page.getByRole('combobox', { name: 'Search syntax', exact: true })).toBeFocused()
    await expect(page.getByText('Applies to .orcasample files.', { exact: true })).toBeVisible()
    await capturePluginEvidence(page, testInfo, 'syntax-choice-menu')
    await page.getByRole('option', { name: 'Plain text', exact: true }).click()
    await expect.poll(() => colors(sampleLine)).toBe(1)
    await expect(picker).toHaveText(/Plain text/)
    await picker.click()
    await page.getByRole('combobox', { name: 'Search syntax', exact: true }).fill('sample')
    await page.getByRole('option').filter({ hasText: 'Sample syntax' }).click()
    await expect.poll(() => colors(sampleLine)).toBeGreaterThan(1)
    await writeFile(samplePath, 'finish "modified" 12\n')
    await page.evaluate(
      ({ worktreeId, samplePath }) => {
        window.__store
          ?.getState()
          .openDiff(worktreeId, samplePath, 'program.orcasample', 'plaintext', false)
      },
      { worktreeId, samplePath }
    )
    const diff = page.locator('.monaco-diff-editor')
    await expect(diff).toBeVisible()
    const original = diff
      .locator('.line-delete .view-line')
      .filter({ hasText: 'launch "original"' })
    const modified = diff
      .locator('.modified-in-monaco-diff-editor .view-line')
      .filter({ hasText: 'finish "modified"' })
    await expect(original).toBeVisible()
    await expect(modified).toBeVisible()
    await expect.poll(() => colors(original)).toBeGreaterThan(1)
    await expect.poll(() => colors(modified)).toBeGreaterThan(1)
    const previousFinishColor = await wordColor(modified, 'finish')
    expect(previousFinishColor).not.toBe('')
    await publishSyntaxFixtureUpdate(fixture)
    await openPlugins(page)
    await page.getByRole('tab', { name: /^All/ }).click()
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    const listing = page.locator('[data-marketplace-plugin-key="stablyai.orca-syntax-sample"]')
    await expect(listing).toContainText('1.1.0')
    await listing.getByRole('button', { name: 'Update', exact: true }).click()
    await page.getByRole('tab', { name: /^Installed/ }).click()
    await expect(page.locator('[data-plugin-key="stablyai.orca-syntax-sample"]')).toContainText(
      '1.1.0'
    )
    await expect(page.getByRole('dialog', { name: 'Review plugin', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(original).toBeVisible()
    await expect(modified).toBeVisible()
    await expect.poll(() => colors(original)).toBeGreaterThan(1)
    await expect.poll(() => colors(modified)).toBeGreaterThan(1)
    await expect.poll(() => wordColor(modified, 'finish')).not.toBe(previousFinishColor)
    await expect.poll(() => wordColor(modified, 'finish')).not.toBe('')
    await capturePluginEvidence(page, testInfo, 'syntax-updated-open-diff')
    await capturePluginEvidence(page, testInfo, 'syntax-installed-inline-diff')
    await openPlugins(page)
    await page.getByRole('tab', { name: /^Installed/ }).click()
    await page.getByRole('switch', { name: 'Disable Sample syntax', exact: true }).click()
    await expect(page.locator('[data-plugin-key="stablyai.orca-syntax-sample"]')).toContainText(
      'Disabled'
    )
    await page.keyboard.press('Escape')
    await expect(original).toBeVisible()
    await expect.poll(() => colors(original)).toBe(1)
    await expect.poll(() => colors(modified)).toBe(1)
    await capturePluginEvidence(page, testInfo, 'syntax-disabled-open-diff')
    await openPlugins(page)
    await page.getByRole('tab', { name: /^Installed/ }).click()
    await page.getByRole('switch', { name: 'Enable Sample syntax', exact: true }).click()
    await expect(page.locator('[data-plugin-key="stablyai.orca-syntax-sample"]')).toContainText(
      'Enabled'
    )
    await page.keyboard.press('Escape')
    await expect.poll(() => colors(original)).toBeGreaterThan(1)
    await expect.poll(() => colors(modified)).toBeGreaterThan(1)
    await openPlugins(page)
    await page.getByRole('tab', { name: /^Installed/ }).click()
    const installed = page.locator('[data-plugin-key="stablyai.orca-syntax-sample"]')
    await expect(installed).toContainText('1.1.0')
    await installed
      .getByRole('button', { name: 'More actions for Sample syntax', exact: true })
      .click()
    await page.getByRole('menuitem', { name: 'Remove', exact: true }).click()
    const remove = page.getByRole('dialog', { name: 'Remove plugin?', exact: true })
    await remove.getByRole('button', { name: 'Remove plugin', exact: true }).click()
    await expect(remove).toBeHidden()
    await expect(installed).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-settings-section="plugins"]')).toBeHidden()
    await expect(original).toBeVisible()
    await expect.poll(() => colors(original)).toBe(1)
    await expect.poll(() => colors(modified)).toBe(1)
    await expect(picker).toHaveText(/Syntax unavailable/)
    await picker.click()
    await expect(
      page.getByText(
        'The selected pack is disabled or unavailable. Choose Automatic to restore the default.',
        { exact: true }
      )
    ).toBeVisible()
    await capturePluginEvidence(page, testInfo, 'syntax-removed-fallback')
    await page.keyboard.press('Escape')
    await session.close(launched.app)
    launched = null
    launched = await session.launch()
    const restarted = launched.page
    const restoredWorktreeId = await attachRepoAndOpenTerminal(restarted, workspace)
    await restarted.evaluate(
      ({ worktreeId, samplePath }) => {
        window.__store?.getState().openFile({
          filePath: samplePath,
          relativePath: 'program.orcasample',
          worktreeId,
          language: 'plaintext',
          mode: 'edit'
        })
      },
      { worktreeId: restoredWorktreeId, samplePath }
    )
    const restoredPicker = restarted.getByRole('combobox', { name: 'Choose syntax', exact: true })
    await expect(restoredPicker).toHaveText(/Syntax unavailable/)
    await restoredPicker.click()
    await expect(
      restarted.getByText('stablyai.orca-syntax-sample/sample', { exact: true })
    ).toBeVisible()
    await capturePluginEvidence(restarted, testInfo, 'syntax-choice-restart')
    await restarted.getByRole('option', { name: 'Automatic', exact: true }).click()
    await expect(restoredPicker).toHaveText(/Automatic/)
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
