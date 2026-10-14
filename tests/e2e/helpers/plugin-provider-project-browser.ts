import { expect, type Page } from '@stablyai/playwright-test'

export async function browseManagedProject(
  page: Page,
  path: string,
  fileName: string
): Promise<void> {
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: /^Browse folder\b/u }).click()
  const input = dialog.getByPlaceholder('Type to filter or enter a path…', { exact: true })
  await input.fill(`${path}/`)
  await expect(dialog.getByText(fileName, { exact: true })).toBeVisible()
  await input.press('Enter')
  const select = dialog.getByRole('button', { name: 'Select folder', exact: true })
  await expect(select).toHaveAttribute('title', path)
  await expect(select).toBeEnabled()
  await select.click()
}

export async function returnToProviderSettings(page: Page): Promise<void> {
  const dismiss = page.getByRole('button', { name: 'Got it', exact: true })
  if (await dismiss.isVisible()) {
    await dismiss.click()
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('combobox', { name: 'Host', exact: true }).click()
  await page.getByRole('option', { name: 'Company Node host', exact: true }).click()
  await page.getByRole('button', { name: 'SSH Hosts', exact: true }).click()
  const machine = page.locator('[data-environment-resource-id="devbox"]')
  if (!(await machine.isVisible())) {
    const provider = page.locator(
      '[data-environment-provider-id="stablyai.orca-environments-devpods/devpods"]'
    )
    await provider.getByRole('button', { name: 'Refresh inventory', exact: true }).click()
  }
  await expect(machine).toBeVisible()
}
