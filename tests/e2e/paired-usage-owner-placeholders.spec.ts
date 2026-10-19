import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'

const HOST_NAME = 'Build server'

// Why: screenshots are the proof artifact; ORCA_E2E_SCREENSHOT_DIR collects them outside test output.
async function shoot(
  page: Page,
  name: string,
  outputPath: (name: string) => string
): Promise<void> {
  const file = process.env.ORCA_E2E_SCREENSHOT_DIR
    ? path.join(process.env.ORCA_E2E_SCREENSHOT_DIR, name)
    : outputPath(name)
  await page.screenshot({ path: file })
}

function minimaxChip(page: Page) {
  return page.locator('[data-usage-chip="minimax"]')
}

test('a provider set up only on this computer stays visible, greyed, under a server workspace', async ({
  sharedPage
}, testInfo) => {
  test.setTimeout(180_000)
  const outputPath = (name: string): string => testInfo.outputPath(name)
  let client: PairedElectronClient | undefined
  try {
    client = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(sharedPage),
      testInfo,
      HOST_NAME
    )
    const { page, environmentId } = client
    await page.setViewportSize({ width: 1280, height: 800 })

    // A failing fetch still counts as set up, so a fake key needs no network.
    await page.evaluate(async () => {
      await window.api.minimaxCredentials.saveApiKey('e2e-fake-minimax-key')
      await window.__store?.getState().refreshRateLimits()
    })
    await page.waitForFunction(
      () => window.__store?.getState().rateLimits.minimaxApiKeyConfigured === true,
      null,
      { timeout: 30_000 }
    )

    // Why: a one-time sidebar hint overlays the usage popover in screenshots until it times out.
    await expect(page.getByText('Workspace board moved to the bottom bar')).toHaveCount(0, {
      timeout: 20_000
    })

    // 1. Nothing focused: this computer owns usage, so its own MiniMax meter shows.
    await page.evaluate(() => window.__store?.getState().setActiveWorktree(null))
    await expect(minimaxChip(page)).toBeVisible({ timeout: 30_000 })
    await expect(minimaxChip(page).locator('[title]')).toHaveCount(0)
    await shoot(page, '1-local-owner-minimax-meter.png', outputPath)

    // 2. Focus a workspace on the paired server: MiniMax becomes a host-named placeholder.
    // Why: a fresh client profile has no repos of its own, so every worktree it lists is the server's.
    await page.waitForFunction(
      () => (window.__store?.getState().allWorktrees().length ?? 0) > 0,
      null,
      {
        timeout: 60_000
      }
    )
    const worktreeId = await page.evaluate(
      () => window.__store?.getState().allWorktrees()[0]?.id ?? null
    )
    if (!worktreeId) {
      throw new Error('Paired client lost the server worktree')
    }
    await page.evaluate(
      ({ env, id }) => window.__store?.getState().setActiveWorktree(id, `runtime:${env}`),
      { env: environmentId, id: worktreeId }
    )
    const placeholder = minimaxChip(page).locator(`[title^="Not set up on ${HOST_NAME}"]`)
    await expect(placeholder).toBeVisible({ timeout: 60_000 })
    await expect(placeholder).toHaveAttribute(
      'title',
      `Not set up on ${HOST_NAME}\nIts key is saved on this computer only.`
    )
    await expect(page.getByText('Configure usage tracking')).toHaveCount(0)
    await expect(page.getByText(`No usage on ${HOST_NAME}`)).toHaveCount(0)
    await shoot(page, '2-server-owner-minimax-placeholder.png', outputPath)

    await page.getByRole('button', { name: 'Usage', exact: true }).click()
    const row = page.getByRole('menuitem').filter({ hasText: `Not set up on ${HOST_NAME}` })
    await expect(row).toBeVisible()
    await expect(row).toContainText('Its key is saved on this computer only.')
    await page
      .getByRole('menu')
      .evaluate((menu) =>
        Promise.all(menu.getAnimations({ subtree: true }).map((animation) => animation.finished))
      )
    await shoot(page, '3-server-owner-usage-popover.png', outputPath)

    // 3. The row opens Settings on the server's accounts.
    await row.click()
    const hostPicker = page.getByRole('combobox', { name: 'Host' })
    await expect(hostPicker).toBeVisible({ timeout: 30_000 })
    await expect(hostPicker).toContainText(HOST_NAME)
    await shoot(page, '4-settings-opened-on-server-accounts.png', outputPath)
  } finally {
    await client?.dispose()
  }
})
