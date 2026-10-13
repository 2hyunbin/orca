import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator } from '@stablyai/playwright-test'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
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

test('the active grammar limit preserves editing and resumes when a real tab closes', async ({
  browserName: _browserName
}, testInfo) => {
  const fixture = await createPluginCatalogFixture({ syntaxPacks: true })
  const repository = join(fixture.root, 'repositories', 'orca-syntax-sample.git')
  const manifestPath = join(repository, 'orca-plugin.json')
  const manifest = pluginManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
  const languages = Array.from({ length: 9 }, (_, index) => ({
    id: `capacity${index + 1}`,
    aliases: [`Capacity ${index + 1}`],
    extensions: [`.cap${index + 1}`],
    configuration: 'configuration.json'
  }))
  const grammars = languages.map((language) => ({
    language: language.id,
    scopeName: `source.${language.id}`,
    path: `${language.id}.json`
  }))
  await writeFile(
    manifestPath,
    JSON.stringify({ ...manifest, version: '1.1.0', contributes: { languages, grammars } })
  )
  for (const grammar of grammars) {
    await writeFile(
      join(repository, grammar.path),
      JSON.stringify({
        scopeName: grammar.scopeName,
        patterns: [
          { match: '\\b(?:launch|typed)\\b', name: 'keyword.control.capacity' },
          { match: '\\b[0-9]+\\b', name: 'constant.numeric.capacity' }
        ]
      })
    )
  }
  await publishCatalogFixtureRelease(fixture, 'orca-syntax-sample', '1.1.0')
  await mkdir(join(fixture.root, 'workspace'))
  const workspace = await realpath(join(fixture.root, 'workspace'))
  const files = languages.map((language, index) => ({
    path: join(workspace, `file${index + 1}${language.extensions[0]}`),
    name: `file${index + 1}${language.extensions[0]}`
  }))
  for (const file of files) {
    await writeFile(file.path, 'launch 42\n')
  }
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
    const listing = page.locator('[data-marketplace-plugin-key="stablyai.orca-syntax-sample"]')
    await listing.getByRole('button', { name: 'Install', exact: true }).click()
    await expect(listing.getByRole('button', { name: 'Update', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    const recovery = page.getByRole('status', { name: 'Highlighting paused', exact: true })
    const line = page.locator('.monaco-editor .view-line').filter({ hasText: 'launch' }).first()
    for (const [index, file] of files.entries()) {
      await page.evaluate(
        ({ file, worktreeId }) =>
          window.__store?.getState().openFile({
            filePath: file.path,
            relativePath: file.name,
            worktreeId,
            language: 'plaintext',
            mode: 'edit'
          }),
        { file, worktreeId }
      )
      await expect
        .poll(() => page.evaluate(() => window.__monacoEditorE2E?.filePath))
        .toBe(file.path)
      if (index < 8) {
        await expect.poll(() => colors(line)).toBeGreaterThan(1)
        await expect(recovery).toBeHidden()
      }
    }
    await expect(recovery).toContainText('Highlighting is at its work limit')
    await expect.poll(() => colors(line)).toBe(1)
    await page.locator('.monaco-editor').first().click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('launch typed 42')
    await expect(recovery).toContainText('Highlighting is at its work limit')
    expect(await page.evaluate(() => window.__monacoEditorE2E?.snapshot().canUndo)).toBe(true)
    await recovery.getByRole('button', { name: 'Retry highlighting', exact: true }).click()
    await expect(recovery).toContainText('Highlighting is at its work limit')
    await capturePluginEvidence(page, testInfo, 'syntax-capacity-file', app)

    const firstTab = page.locator('[data-tab-id]').filter({ hasText: files[0].name })
    await firstTab.hover()
    await firstTab.getByRole('button', { name: 'Close tab', exact: true }).click()
    await expect(firstTab).toHaveCount(0)
    await expect(recovery).toBeHidden()
    await expect.poll(() => colors(line)).toBeGreaterThan(1)
    expect(await page.evaluate(() => window.__monacoEditorE2E?.snapshot().valueTail)).toBe(
      'launch typed 42'
    )
    await capturePluginEvidence(page, testInfo, 'syntax-capacity-recovered', app)
    await page.locator('.monaco-editor').first().click()
    let undoSteps = 0
    while (undoSteps < 8) {
      const previous = await page.evaluate(() => window.__monacoEditorE2E?.snapshot().valueLength)
      if (previous === 'launch 42\n'.length) {
        break
      }
      await page.keyboard.press('ControlOrMeta+z')
      await expect
        .poll(() => page.evaluate(() => window.__monacoEditorE2E?.snapshot().valueLength))
        .not.toBe(previous)
      undoSteps++
    }
    await expect
      .poll(() => page.evaluate(() => window.__monacoEditorE2E?.snapshot().valueTail))
      .toBe('launch 42')
    await expect.poll(() => colors(line)).toBeGreaterThan(1)
    for (let step = 0; step < undoSteps; step++) {
      await page.keyboard.press('ControlOrMeta+Shift+z')
    }
    await expect
      .poll(() => page.evaluate(() => window.__monacoEditorE2E?.snapshot().valueTail))
      .toBe('launch typed 42')
    await expect.poll(() => colors(line)).toBeGreaterThan(1)
    await expect(recovery).toBeHidden()
    expect(await readFile(files[8].path, 'utf8')).toBe('launch 42\n')
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
