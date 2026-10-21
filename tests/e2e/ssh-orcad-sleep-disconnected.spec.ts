/**
 * Sleeping a workspace on an orcad-managed SSH host while the network to that host is gone: the
 * host cannot confirm the stop, so the workspace stays open and visible (Hide sleeping on) with
 * today's "kept open" toast, its shell keeps running on the host, and sleeping again once the
 * network is back puts it to sleep. Loss of contact is never taken as the terminals exiting.
 */
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { startFreezableTcpProxy, type FreezableTcpProxy } from './helpers/freezable-tcp-proxy'
import {
  echoMarker,
  launchManagedWorkspace,
  openTerminalTab,
  skipUnlessManagedDockerHost,
  withManagedHost
} from './helpers/orcad-managed-workspace'

skipUnlessManagedDockerHost()
test.skip(process.platform === 'win32', 'The Docker SSH host uses POSIX tooling')

const KEPT_OPEN = /kept open/

/** The sidebar's Sleep on the workspace's row, as a user does it. */
async function sleepFromSidebar(page: Page, worktreeId: string): Promise<void> {
  const row = page.locator(`[data-worktree-sidebar] [data-worktree-id="${worktreeId}"]`).first()
  await row.scrollIntoViewIfNeeded()
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Sleep', exact: true }).click()
}

function livePtys(page: Page, worktreeId: string): Promise<number> {
  return page.evaluate((id) => {
    const state = window.__store!.getState()
    return (state.tabsByWorktree[id] ?? []).reduce(
      (n, tab) => n + (state.ptyIdsByTabId[tab.id]?.length ?? 0),
      0
    )
  }, worktreeId)
}

test('sleep on a disconnected SSH host keeps the workspace open, and sleeping again retries', async (// oxlint-disable-next-line no-empty-pattern -- Owns its app launch through a restart session.
{}, testInfo) => {
  test.setTimeout(12 * 60_000)
  let proxy: FreezableTcpProxy | null = null
  try {
    await withManagedHost(testInfo, async (fixture) => {
      const { host } = fixture
      proxy = await startFreezableTcpProxy(host.input.host, host.input.port ?? 22)
      host.input = { ...host.input, port: proxy.port }
      const { page, seeded } = await launchManagedWorkspace(fixture)
      const tabId = await openTerminalTab(page, seeded.worktreeId)
      await echoMarker(page, tabId, 'BEFORE_SLEEP')
      await page.evaluate(() => window.__store!.getState().setShowSleepingWorkspaces(false))
      const row = page
        .locator(`[data-worktree-sidebar] [data-worktree-id="${seeded.worktreeId}"]`)
        .first()

      proxy.cut('silent')
      await sleepFromSidebar(page, seeded.worktreeId)
      await expect(page.getByText(KEPT_OPEN).first()).toBeVisible({ timeout: 90_000 })
      // Unconfirmed, so neither hidden as asleep nor counted as exited.
      await expect(row).toBeVisible()
      expect(await livePtys(page, seeded.worktreeId)).toBeGreaterThan(0)
      await page.screenshot({ path: testInfo.outputPath('kept-open.png') })

      proxy.restore()
      await expect
        .poll(
          async () => {
            // Sleeping again is the retry: the host's own answer resumes the paused queue.
            await sleepFromSidebar(page, seeded.worktreeId)
            await page.waitForTimeout(3_000)
            return livePtys(page, seeded.worktreeId)
          },
          { timeout: 180_000, intervals: [5_000] }
        )
        .toBe(0)
      await expect(row).toBeHidden({ timeout: 30_000 })
    })
  } finally {
    await proxy?.close()
  }
})
