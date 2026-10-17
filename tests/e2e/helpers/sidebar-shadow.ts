import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'

/** Main's sidebar inputs agree with what the window derives itself (dev/test shadow mode). */
export async function expectNoSidebarShadowMismatches(page: Page): Promise<void> {
  const comparisons = (): Promise<number> =>
    page.evaluate(() => window.__sidebarShadow?.comparisons() ?? -1)
  const start = await comparisons()
  // Two fresh comparisons: a disagreement is recorded once it holds across a whole interval.
  await expect
    .poll(comparisons, { timeout: 15_000, message: 'main never answered a shadow comparison' })
    .toBeGreaterThanOrEqual(Math.max(start, 0) + 2)
  const mismatches = await page.evaluate(() => window.__sidebarShadow?.mismatches() ?? [])
  expect(mismatches, JSON.stringify(mismatches, null, 2)).toEqual([])
}
