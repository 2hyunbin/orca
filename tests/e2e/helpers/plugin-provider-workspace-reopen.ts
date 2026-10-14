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
}): Promise<void> {
  const machine = input.page.locator('[data-environment-resource-id="devbox"]')
  await machine.getByRole('button', { name: /^(Connect|Reconnect)$/u }).click()
  const review = input.page.getByRole('dialog', { name: 'Connect to environment', exact: true })
  await review.getByRole('button', { name: 'Save & connect', exact: true }).click()
  await expect(review).toBeHidden({ timeout: 60_000 })
  await machine.getByRole('button', { name: 'Open workspace', exact: true }).click()
  const project = input.page.getByRole('dialog')
  await expect(project).toBeVisible({ timeout: 30_000 })
  await project.getByRole('button', { name: 'Close', exact: true }).click()
  await input.page.getByRole('button', { name: 'Back to app', exact: true }).click()
  await input.page.getByText('Provider folder workspace', { exact: true }).click()
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
    'node-provider-saved-workspace-reopened-native',
    input.app
  )
  expect(await input.page.evaluate(() => Boolean(window.__store))).toBe(false)
}
