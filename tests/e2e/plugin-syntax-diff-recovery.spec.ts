import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@stablyai/playwright-test'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { capturePluginEvidence } from './helpers/plugin-evidence'

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

async function settledSnapshot(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const before = window.__monacoDiffE2E?.snapshot()
        await new Promise<void>((done) => requestAnimationFrame(() => done()))
        await new Promise<void>((done) => requestAnimationFrame(() => done()))
        const after = window.__monacoDiffE2E?.snapshot()
        return Boolean(
          before &&
          after &&
          before.original.scrollTop === after.original.scrollTop &&
          before.modified.scrollTop === after.modified.scrollTop
        )
      })
    )
    .toBe(true)
  return page.evaluate(() => window.__monacoDiffE2E?.snapshot())
}

test('diff recovery names the failed side and preserves both model selections, scroll and modified Undo', async ({
  browserName: _browserName
}, testInfo) => {
  const fixture = await createPluginCatalogFixture()
  await mkdir(join(fixture.root, 'workspace'))
  const workspace = await realpath(join(fixture.root, 'workspace'))
  const originalPath = join(workspace, 'original-large.typ')
  const modifiedPath = join(workspace, 'modified-large.typ')
  const largeText = '#let original = 12pt\n'.repeat(20_001)
  const smallText = '#let modified = 12pt\n'
  await writeFile(originalPath, largeText)
  await writeFile(modifiedPath, smallText)
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
    'diff syntax recovery fixture'
  ])
  await writeFile(originalPath, smallText)
  await writeFile(modifiedPath, largeText)
  const session = createRestartSession(testInfo, fixture.gitEnvironment)
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch()
    const { page, app } = launched
    const worktreeId = await attachRepoAndOpenTerminal(page, workspace)
    await page.evaluate(
      ({ originalPath, worktreeId }) =>
        window.__store
          ?.getState()
          .openDiff(worktreeId, originalPath, 'original-large.typ', 'typst', false, {
            preview: false
          }),
      { originalPath, worktreeId }
    )
    const diff = page.locator('.monaco-diff-editor')
    await expect(diff).toBeVisible()
    const switchToSplit = page.getByRole('button', {
      name: 'Switch to side-by-side diff',
      exact: true
    })
    if (await switchToSplit.isVisible()) {
      await switchToSplit.click()
    }
    const original = diff.locator('.original-in-monaco-diff-editor')
    const modified = diff.locator('.modified-in-monaco-diff-editor')
    await expect(original).toBeVisible()
    const modifiedLine = modified.locator('.view-line').filter({ hasText: '#let modified' }).first()
    await expect.poll(() => colors(modifiedLine)).toBeGreaterThan(1)
    const recovery = page.getByRole('status', { name: 'Highlighting paused', exact: true })
    await expect(recovery).toContainText('Original')
    await expect(recovery).toContainText('exceeds the highlighting limit')
    const originalBefore = await settledSnapshot(page)
    expect(originalBefore?.original.valueLength).toBe(largeText.length)
    await original.locator('.view-line').filter({ hasText: '#let original' }).first().click()
    await page.keyboard.type('NOT_ALLOWED')
    expect((await settledSnapshot(page))?.original.valueLength).toBe(largeText.length)
    await capturePluginEvidence(page, testInfo, 'syntax-diff-original-limit', app)
    await modifiedLine.click()
    const mac = await page.evaluate(() => navigator.userAgent.includes('Mac'))
    await page.keyboard.press(mac ? 'Meta+ArrowDown' : 'Control+End')
    await page.keyboard.type('//typed')
    await expect
      .poll(() => page.evaluate(() => window.__monacoDiffE2E?.snapshot().modified.valueTail))
      .toBe('//typed')
    const before = await settledSnapshot(page)
    expect(before?.modified.canUndo).toBe(true)
    const picker = page.getByRole('combobox', { name: 'Choose syntax', exact: true })
    for (let cycle = 0; cycle < 3; cycle++) {
      await picker.click()
      await page.locator('[role="option"][data-value="plaintext"]').click()
      await expect(recovery).toBeHidden()
      await picker.click()
      await page.locator('[role="option"][data-value="auto"]').click()
      await expect(recovery).toContainText('Original')
      await expect.poll(() => colors(modifiedLine)).toBeGreaterThan(1)
      expect(await settledSnapshot(page)).toEqual(before)
    }
    await capturePluginEvidence(page, testInfo, 'syntax-diff-state-preserved', app)
    await modified.locator('.view-line').filter({ hasText: '//typed' }).click()
    let undoSteps = 0
    while (undoSteps < 8) {
      const previous = await page.evaluate(
        () => window.__monacoDiffE2E?.snapshot().modified.valueLength
      )
      if (previous === originalBefore?.modified.valueLength) {
        break
      }
      await page.keyboard.press('ControlOrMeta+z')
      await expect
        .poll(() => page.evaluate(() => window.__monacoDiffE2E?.snapshot().modified.valueLength))
        .not.toBe(previous)
      undoSteps++
    }
    await expect
      .poll(() => page.evaluate(() => window.__monacoDiffE2E?.snapshot().modified.valueLength))
      .toBe(originalBefore?.modified.valueLength)
    await expect.poll(() => colors(modifiedLine)).toBeGreaterThan(1)
    for (let step = 0; step < undoSteps; step++) {
      await page.keyboard.press('ControlOrMeta+Shift+z')
    }
    await expect
      .poll(() => page.evaluate(() => window.__monacoDiffE2E?.snapshot().modified.valueTail))
      .toBe('//typed')
    await expect.poll(() => colors(modifiedLine)).toBeGreaterThan(1)
    expect(await readFile(originalPath, 'utf8')).toBe(smallText)
    await page.getByRole('button', { name: 'Switch to inline diff', exact: true }).click()
    await expect(recovery).toContainText('Original')
    await page.evaluate(
      ({ modifiedPath, worktreeId }) =>
        window.__store
          ?.getState()
          .openDiff(worktreeId, modifiedPath, 'modified-large.typ', 'typst', false, {
            preview: false
          }),
      { modifiedPath, worktreeId }
    )
    await expect(recovery).toContainText('Modified')
    await expect(recovery).toContainText('exceeds the highlighting limit')
    await recovery.getByRole('button', { name: 'Retry highlighting', exact: true }).click()
    await expect(recovery).toContainText('Modified')
    await capturePluginEvidence(page, testInfo, 'syntax-diff-modified-limit', app)
    expect(await readFile(modifiedPath, 'utf8')).toBe(largeText)
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
