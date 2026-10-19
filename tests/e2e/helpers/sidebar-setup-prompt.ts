import type { Locator, Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

// The seeded repo's detected setup command shows a prompt card over the sidebar's lower rows.

/** Dismisses the setup-script prompt when it covers the row, as a user would to reach it. */
export async function uncoverSidebarRow(page: Page, row: Locator): Promise<void> {
  const prompt = page.locator('[data-setup-script-prompt-layer]').first()
  if (!(await prompt.isVisible())) {
    return
  }
  const [rowBox, promptBox] = await Promise.all([row.boundingBox(), prompt.boundingBox()])
  if (
    rowBox &&
    promptBox &&
    rowBox.y + rowBox.height > promptBox.y &&
    rowBox.y < promptBox.y + promptBox.height
  ) {
    await prompt.getByRole('button', { name: 'Dismiss setup scripts' }).click()
    await expect(prompt).toBeHidden()
  }
}
