import { randomUUID } from 'node:crypto'
import { writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree } from './helpers/store'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import { capturePluginEvidence } from './helpers/plugin-evidence'

test('package retokenization and syntax changes preserve editor selection, viewport and undo history', async ({
  orcaPage: page,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  const context = await getActiveWorktreeContext(page)
  const relativePath = `syntax-state-${randomUUID()}.typ`
  const filePath = join(context.rootPath, relativePath)
  const source = Array.from({ length: 360 }, (_, index) => `#let value_${index + 1} = 12pt`).join(
    '\n'
  )
  await writeFile(filePath, source)
  registerPostElectronShutdownCleanup(() => rm(filePath, { force: true }))
  await page.evaluate(
    ({ filePath, relativePath, worktreeId }) =>
      window.__store?.getState().openFile({
        filePath,
        relativePath,
        worktreeId,
        language: 'typst',
        mode: 'edit'
      }),
    { filePath, relativePath, worktreeId: context.worktreeId }
  )
  const editor = page.locator('.monaco-editor').first()
  await expect(editor).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__monacoEditorE2E?.filePath)).toBe(filePath)
  const snapshot = () => page.evaluate(() => window.__monacoEditorE2E?.snapshot())
  const find = async (text: string) => {
    await editor.click()
    await page.keyboard.press('ControlOrMeta+f')
    const input = editor.locator('.find-widget .input[aria-label="Find"]')
    await expect(input).toBeVisible()
    await input.fill(text)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
  }
  const colors = async () =>
    editor
      .locator('.view-line')
      .filter({ hasText: '#let value_220 = 12pt' })
      .locator('span')
      .evaluateAll(
        (spans) =>
          new Set(
            spans
              .filter((span) => !span.childElementCount && span.textContent?.trim())
              .map((span) => getComputedStyle(span).color)
          ).size
      )
  expect((await snapshot())?.canUndo).toBe(false)
  await find('value_180')
  await page.keyboard.type('edited_value_180')
  await expect.poll(async () => (await snapshot())?.valueLength).toBe(source.length + 7)
  await find('value_220')
  await expect.poll(colors).toBeGreaterThan(1)
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const first = window.__monacoEditorE2E?.snapshot().scrollTop
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        return first !== undefined && first === window.__monacoEditorE2E?.snapshot().scrollTop
      })
    )
    .toBe(true)
  const before = await snapshot()
  if (!before?.selection) {
    throw new Error('Editor selection missing before syntax refresh')
  }
  expect(before.scrollTop).toBeGreaterThan(1000)
  expect(before.canUndo).toBe(true)
  expect(before.selection.selectionStartColumn).not.toBe(before.selection.positionColumn)
  const assertState = async () => {
    const actual = await snapshot()
    expect(actual?.selection).toEqual(before.selection)
    expect(actual?.scrollTop).toBeCloseTo(before.scrollTop, 0)
    expect(actual?.valueLength).toBe(before.valueLength)
    expect(actual?.canUndo).toBe(true)
  }
  const picker = page.getByRole('combobox', { name: 'Choose syntax', exact: true })
  await picker.click()
  await page.locator('[role="option"][data-value="plaintext"]').click()
  await expect.poll(colors).toBe(1)
  await assertState()
  await picker.click()
  await page.locator('[role="option"][data-value="auto"]').click()
  await expect.poll(colors).toBeGreaterThan(1)
  await assertState()
  const bounds = await editor.boundingBox()
  if (bounds) {
    await page.mouse.move(bounds.x + bounds.width * 0.8, bounds.y + bounds.height * 0.2)
  }
  await capturePluginEvidence(page, testInfo, 'syntax-editor-state-preserved', electronApp)

  await editor.click()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await snapshot())?.valueLength).toBe(source.length)
  await find('value_180')
  await expect(
    editor.locator('.view-line').filter({ hasText: '#let value_180 = 12pt' })
  ).toBeVisible()
  expect((await snapshot())?.canUndo).toBe(false)
  await expect.poll(colors).toBeGreaterThan(1)
  await capturePluginEvidence(page, testInfo, 'syntax-editor-undo-preserved', electronApp)
  await editor.click()
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(async () => (await snapshot())?.valueLength).toBe(source.length + 7)
  await find('edited_value_180')
  await expect(
    editor.locator('.view-line').filter({ hasText: '#let edited_value_180 = 12pt' })
  ).toBeVisible()
  await expect.poll(colors).toBeGreaterThan(1)
})
