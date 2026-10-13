import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import typstGrammar from '../../src/renderer/src/lib/monaco-languages/textmate-grammars/typst.tmLanguage.json'
import { capturePluginEvidence } from './helpers/plugin-evidence'

test('worker grammar bridge colors multiline text, rejects stale results and recovers after hostile regex', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  const filePath = join(context.rootPath, `grammar-probe-${testInfo.workerIndex}.txt`)
  const text = ['/* comment opens', '#let hidden = 12pt', '*/', '#let visible = 12pt'].join('\n')
  await writeFile(filePath, text)
  try {
    await orcaPage.evaluate(
      ({ filePath, worktreeId }) => {
        const state = window.__store?.getState()
        if (!state) {
          throw new Error('Store unavailable')
        }
        state.openFile({
          filePath,
          relativePath: 'grammar-probe.txt',
          worktreeId,
          language: 'plaintext',
          mode: 'edit'
        })
      },
      { filePath, worktreeId: context.worktreeId }
    )
    const editor = orcaPage.locator('.monaco-editor').first()
    await expect(editor).toBeVisible()
    await orcaPage.waitForFunction(() => Boolean(window.__pluginGrammarE2E))
    await orcaPage.evaluate((grammar) => {
      window.__pluginGrammarE2E?.configure('source.typst', [
        { scopeName: 'source.typst', content: JSON.stringify(grammar) }
      ])
    }, typstGrammar)
    const colors = async (marker: string) =>
      editor
        .locator('.view-line')
        .filter({ hasText: marker })
        .locator('span')
        .evaluateAll(
          (spans) =>
            new Set(
              spans
                .filter((span) => !span.childElementCount && span.textContent?.trim())
                .map((span) => getComputedStyle(span).color)
            ).size
        )
    await expect
      .poll(() => colors('#let visible'), {
        message: 'Code after a multiline comment receives syntax colors'
      })
      .toBeGreaterThan(1)
    await expect
      .poll(() => colors('#let hidden'), { message: 'Comment state carries across lines' })
      .toBe(1)
    await capturePluginEvidence(orcaPage, testInfo, 'grammar-multiline')
    await orcaPage.evaluate(() =>
      window.__pluginGrammarE2E?.replace('\n#let hidden = 12pt\n\n#let visible = 12pt')
    )
    await expect
      .poll(() => colors('#let hidden'), {
        message: 'Editing the opener retokenizes subsequent lines'
      })
      .toBeGreaterThan(1)

    const hostileGrammar = {
      scopeName: 'source.hostile',
      patterns: [
        ...Array.from({ length: 80 }, (_, index) => ({
          match: `(?:a|aa|x${index})+$`,
          name: 'keyword.hostile'
        })),
        { match: '\\brecovered\\b', name: 'keyword.recovery' }
      ]
    }
    await orcaPage.evaluate((grammar) => {
      window.__pluginGrammarE2E?.replace(`${'a'.repeat(200_000)}!`)
      window.__pluginGrammarE2E?.configure('source.hostile', [
        { scopeName: 'source.hostile', content: JSON.stringify(grammar) }
      ])
    }, hostileGrammar)
    await expect
      .poll(() =>
        orcaPage.evaluate(() => window.__pluginGrammarE2E?.diagnostics()?.startedWorkers ?? 0)
      )
      .toBeGreaterThan(0)
    // A DOM input remains interactive while the worker is inside Oniguruma.
    const settings = orcaPage.getByRole('button', { name: 'Settings', exact: true })
    await settings.click({ timeout: 1_500 })
    const search = orcaPage.getByRole('textbox', { name: /Search settings/ })
    await expect(search).toBeVisible({ timeout: 1_500 })
    await search.fill('appearance', { timeout: 1_500 })
    await expect(search).toHaveValue('appearance', { timeout: 1_500 })
    await expect
      .poll(
        () =>
          orcaPage.evaluate(() => window.__pluginGrammarE2E?.diagnostics()?.timedOutWorkers ?? 0),
        { timeout: 8_000 }
      )
      .toBeGreaterThan(0)
    await orcaPage.keyboard.press('Escape')
    await orcaPage.evaluate(() => {
      window.__pluginGrammarE2E?.replace('#let recovered = 12pt')
    })
    await expect.poll(() => colors('#let recovered')).toBeGreaterThan(1)
    expect(
      await orcaPage.evaluate(() => window.__pluginGrammarE2E?.diagnostics()?.startedWorkers)
    ).toBe(2)
    await orcaPage.evaluate(() => window.__pluginGrammarE2E?.dispose())
    await expect
      .poll(() => colors('#let recovered'), {
        message: 'Disposal restores the original plain-text language'
      })
      .toBe(1)
    await orcaPage.evaluate((grammar) => {
      window.__pluginGrammarE2E?.replace(`${'a'.repeat(200_000)}!`)
      window.__pluginGrammarE2E?.configure('source.hostile', [
        { scopeName: 'source.hostile', content: JSON.stringify(grammar) }
      ])
    }, hostileGrammar)
    await expect
      .poll(() =>
        orcaPage.evaluate(() => window.__pluginGrammarE2E?.diagnostics()?.startedWorkers ?? 0)
      )
      .toBeGreaterThan(0)
    await orcaPage.locator('[data-tab-id]').filter({ hasText: 'grammar-probe.txt' }).last().hover()
    await orcaPage
      .locator('[data-tab-id]')
      .filter({ hasText: 'grammar-probe.txt' })
      .last()
      .getByRole('button', { name: 'Close tab' })
      .click({ timeout: 1_500 })
    await orcaPage
      .getByRole('button', { name: "Don't Save", exact: true })
      .click({ timeout: 1_500 })
    await expect(editor).toBeHidden({ timeout: 1_500 })
  } finally {
    await orcaPage.evaluate(() => window.__pluginGrammarE2E?.dispose()).catch(() => {})
    await rm(filePath, { force: true })
  }
})

test('worker syntax colors read-only files and both models of a real Git diff', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  const filePath = join(context.rootPath, `grammar-readonly-${testInfo.workerIndex}.txt`)
  const trackedPath = join(context.rootPath, 'src', 'index.ts')
  const original = await readFile(trackedPath, 'utf8')
  await writeFile(filePath, '/* comment\n#let hidden = 12pt\n*/\n#let readonly = 12pt')
  try {
    await orcaPage.evaluate(
      ({ filePath, worktreeId }) => {
        window.__store?.getState().openFile({
          filePath,
          relativePath: 'grammar-readonly.txt',
          worktreeId,
          language: 'plaintext',
          mode: 'edit',
          readOnly: true
        })
      },
      { filePath, worktreeId: context.worktreeId }
    )
    await expect(orcaPage.locator('.monaco-editor')).toBeVisible()
    await orcaPage.waitForFunction(() => Boolean(window.__pluginGrammarE2E))
    await orcaPage.evaluate(
      (grammar) =>
        window.__pluginGrammarE2E?.configure('source.typst', [
          { scopeName: 'source.typst', content: JSON.stringify(grammar) }
        ]),
      typstGrammar
    )
    const readonlyLine = orcaPage.locator('.view-line').filter({ hasText: '#let readonly' })
    await expect
      .poll(() =>
        readonlyLine
          .locator('span')
          .evaluateAll(
            (spans) =>
              new Set(
                spans
                  .filter((span) => !span.childElementCount && span.textContent?.trim())
                  .map((span) => getComputedStyle(span).color)
              ).size
          )
      )
      .toBeGreaterThan(1)
    await capturePluginEvidence(orcaPage, testInfo, 'grammar-readonly')
    await orcaPage.evaluate(() => window.__pluginGrammarE2E?.dispose())
    await writeFile(trackedPath, '/* comment\n#let hidden = 12pt\n*/\n#let modified = 12pt\n')
    await orcaPage.evaluate(
      ({ worktreeId, trackedPath }) => {
        window.__store
          ?.getState()
          .openDiff(worktreeId, trackedPath, 'src/index.ts', 'plaintext', false)
      },
      { worktreeId: context.worktreeId, trackedPath }
    )
    const diff = orcaPage.locator('.monaco-diff-editor')
    await expect(diff).toBeVisible()
    await expect(diff.locator('.view-line').filter({ hasText: '#let modified' })).toBeVisible()
    const diffGrammar = {
      scopeName: 'source.diff-probe',
      patterns: [
        { begin: '/\\*', end: '\\*/', name: 'comment.block' },
        { begin: '"', end: '"', name: 'string.quoted.double' },
        { match: '\\b(?:export|const|let)\\b', name: 'keyword.other' },
        { match: '\\b[0-9]+(?:pt)?\\b', name: 'constant.numeric' }
      ]
    }
    await orcaPage.evaluate(
      (grammar) =>
        window.__pluginGrammarE2E?.configure('source.diff-probe', [
          { scopeName: 'source.diff-probe', content: JSON.stringify(grammar) }
        ]),
      diffGrammar
    )
    const modified = diff
      .locator('.modified-in-monaco-diff-editor .view-line')
      .filter({ hasText: '#let modified' })
    await expect
      .poll(() =>
        modified
          .locator('span')
          .evaluateAll(
            (spans) =>
              new Set(
                spans
                  .filter((span) => !span.childElementCount && span.textContent?.trim())
                  .map((span) => getComputedStyle(span).color)
              ).size
          )
      )
      .toBeGreaterThan(1)
    const originalLine = diff
      .locator('.line-delete .view-line')
      .filter({ hasText: 'export const hello' })
    await expect(originalLine).toBeVisible()
    await expect
      .poll(() =>
        originalLine
          .locator('span')
          .evaluateAll(
            (spans) =>
              new Set(
                spans
                  .filter((span) => !span.childElementCount && span.textContent?.trim())
                  .map((span) => getComputedStyle(span).color)
              ).size
          )
      )
      .toBeGreaterThan(1)
    await capturePluginEvidence(orcaPage, testInfo, 'grammar-git-diff')
  } finally {
    await orcaPage.evaluate(() => window.__pluginGrammarE2E?.dispose()).catch(() => {})
    await writeFile(trackedPath, original)
    await rm(filePath, { force: true })
  }
})
