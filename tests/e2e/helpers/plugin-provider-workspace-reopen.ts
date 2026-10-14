import {
  expect,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@stablyai/playwright-test'
import { capturePluginEvidence } from './plugin-evidence'

export async function qualifyProviderWorkspaceReopen(input: {
  page: Page
  app: ElectronApplication
  testInfo: TestInfo
  captureName?: string
}): Promise<void> {
  const machine = input.page.locator('[data-environment-resource-id="devbox"]')
  await machine.getByRole('button', { name: /^(Connect|Reconnect)$/u }).click()
  const review = input.page.getByRole('dialog', { name: 'Connect to environment', exact: true })
  await review.getByRole('button', { name: 'Save & connect', exact: true }).click()
  await expect(review).toBeHidden({ timeout: 60_000 })
  await machine.getByRole('button', { name: 'Open workspace', exact: true }).click()
  const project = input.page.getByRole('dialog')
  await expect(project).toBeVisible({ timeout: 30_000 })
  const nativeWindow = await input.app.browserWindow(input.page)
  try {
    await nativeWindow.evaluate((window) => window.setSize(1000, 720))
  } finally {
    await nativeWindow.dispose()
  }
  const bounds = await project.boundingBox()
  const viewport = await input.page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  expect(bounds).not.toBeNull()
  if (!bounds) {
    throw new Error('The workspace dialog has no rendered bounds')
  }
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.y).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height)
  await expect(project.getByRole('region', { name: 'Saved workspaces', exact: true })).toBeVisible()
  await capturePluginEvidence(
    input.page,
    input.testInfo,
    'node-provider-saved-workspace-picker-native',
    input.app
  )
  const saved = project.getByRole('button', { name: 'Open Provider folder workspace', exact: true })
  await saved.focus()
  await expect(saved).toBeFocused()
  await input.page.keyboard.press('Enter')
  await expect(project).toBeHidden()
  await input.page.getByRole('button', { name: /^Explorer\b/u }).click()
  await input.page
    .locator('[data-file-explorer-row]')
    .filter({
      has: input.page.getByText('child-proof.txt', { exact: true })
    })
    .dblclick({ position: { x: 200, y: 12 } })
  await expect(input.page.locator('.monaco-editor .view-lines')).toContainText(
    'Edited through the control host.'
  )
  await capturePluginEvidence(
    input.page,
    input.testInfo,
    input.captureName ?? 'node-provider-saved-workspace-reopened-native',
    input.app
  )
  expect(await input.page.evaluate(() => Boolean(window.__store))).toBe(false)
}
