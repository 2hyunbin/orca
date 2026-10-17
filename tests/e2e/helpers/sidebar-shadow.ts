import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'

// Two check intervals: a disagreement is recorded only once it has held across a whole one.
const SETTLE_MS = 3_500

/** Main's sidebar inputs agree with what the window derives itself (dev/test shadow mode). */
export async function expectNoSidebarShadowMismatches(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__sidebarShadow !== undefined), {
      message: 'the sidebar shadow comparison never installed'
    })
    .toBe(true)
  await page.waitForTimeout(SETTLE_MS)
  const mismatches = await page.evaluate(() => window.__sidebarShadow?.mismatches() ?? [])
  expect(mismatches, JSON.stringify(mismatches, null, 2)).toEqual([])
}
