import { expect, type Page } from '@stablyai/playwright-test'

export async function chooseNamedPluginViewerFile(
  page: Page,
  filePath: string,
  beforeOpen?: () => Promise<void>
): Promise<void> {
  const newTab = page.getByRole('button', { name: 'New tab', exact: true }).last()
  await newTab.press('Space')
  const input = page.locator('input[role="combobox"][aria-autocomplete="list"]:visible')
  await expect(input).toBeVisible()
  await input.fill(filePath)
  const action = page.getByRole('option').filter({ hasText: 'Open file' }).first()
  await expect(action).toContainText('Read only')
  await expect(action).toContainText(filePath.split(/[\\/]/).at(-1)!)
  await beforeOpen?.()
  await action.click()
  await expect(input).toBeHidden()
}

export async function openNamedPluginViewerFile(
  page: Page,
  filePath: string,
  beforeOpen?: () => Promise<void>
): Promise<void> {
  await chooseNamedPluginViewerFile(page, filePath, beforeOpen)
  await expect(page.locator('[data-plugin-file-viewer]:visible')).toBeVisible()
}
