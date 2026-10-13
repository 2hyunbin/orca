import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, type Page } from '@stablyai/playwright-test'

export async function captureDirectoryScreenshot(page: Page, name: string): Promise<void> {
  const evidence = resolve(
    process.env.ORCA_PLUGIN_EVIDENCE_DIR ?? 'reports/plugin-system/evidence/directory'
  )
  await mkdir(evidence, { recursive: true })
  await page.screenshot({
    path: join(evidence, `${name}.png`),
    fullPage: (await page.getByRole('dialog').count()) === 0,
    animations: 'disabled'
  })
}

export async function assertDirectoryWithinViewport(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

export async function assertDirectoryCategoryLayout(page: Page): Promise<void> {
  const [categories, lastTab, firstCard] = await Promise.all([
    page.getByRole('tablist', { name: 'Plugin categories' }).boundingBox(),
    page.getByRole('tab', { name: 'Other', exact: true }).boundingBox(),
    page.getByRole('button', { name: 'View Portuguese (Brazil)', exact: true }).boundingBox()
  ])
  if (!categories || !lastTab || !firstCard) {
    throw new Error('Directory layout elements missing')
  }
  expect(categories.y + categories.height).toBeGreaterThanOrEqual(lastTab.y + lastTab.height)
  expect(firstCard.y).toBeGreaterThanOrEqual(lastTab.y + lastTab.height)
}
