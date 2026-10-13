import type { Page } from '@stablyai/playwright-test'

export async function installPluginEnvironmentProvider(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  const feature = page.getByRole('switch', { name: 'Plugin system', exact: true })
  if (!(await feature.isChecked())) {
    await feature.click()
  }
  await page.getByRole('combobox', { name: 'Plugin type', exact: true }).click()
  await page.getByRole('option', { name: 'Environment providers', exact: true }).click()
  await page
    .locator('[data-marketplace-plugin-key="stablyai.orca-environments-devpods"]')
    .getByRole('button', { name: 'Install', exact: true })
    .click()
  await page
    .getByRole('dialog', { name: 'Development environments', exact: true })
    .getByRole('button', { name: 'Install plugin', exact: true })
    .click()
  await page
    .getByRole('dialog', { name: 'Review environment provider', exact: true })
    .getByRole('button', { name: 'Enable plugin', exact: true })
    .click()
  await page.getByRole('button', { name: 'SSH Hosts', exact: true }).click()
  return page.locator('[data-environment-provider-id="stablyai.orca-environments-devpods/devpods"]')
}
