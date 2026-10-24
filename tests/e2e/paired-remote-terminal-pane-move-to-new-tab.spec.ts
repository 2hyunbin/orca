import type {
  RuntimeMobileSessionTabsResult,
  RuntimeTerminalListResult
} from '../../src/shared/runtime-types'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import { dragPaneOutToTabStrip, waitForBoundPanes } from './helpers/terminal-layout-journeys'
import { splitActiveTerminalPane } from './helpers/terminal'

const PANE = '.pane[data-leaf-id]:visible'
const TAB = '[data-testid="sortable-tab"]'

type HostLeaves = Record<string, string[]>

/** The server's tabs, each with the leaves it holds. */
function hostLeavesByTab(result: RuntimeMobileSessionTabsResult): HostLeaves {
  const byTab: HostLeaves = {}
  for (const surface of result.tabs) {
    if (surface.type === 'terminal' && surface.leafId) {
      ;(byTab[surface.parentTabId] ??= []).push(surface.leafId)
    }
  }
  return byTab
}

// #32939: a pane dragged out of a split into a new tab on a server workspace must move on the
// server too, or the server's next snapshot puts it back into the split.
test('a pane moved to a new tab on a paired server workspace stays in its new tab', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const host = await launchHeadlessPairedRuntimeHost()
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    const desktop = await launchPairedElectronClient(host.offer, testInfo, 'pane move')
    try {
      const page = desktop.page
      let worktreeId = ''
      await expect
        .poll(
          async () =>
            (worktreeId = await page.evaluate(
              (repo) =>
                window.__store
                  ?.getState()
                  .allWorktrees()
                  .find((worktree) => worktree.path === repo)?.id ?? '',
              testRepoPath
            )),
          { timeout: 60_000 }
        )
        .not.toBe('')
      const worktree = `id:${worktreeId}`
      const readHost = async (): Promise<HostLeaves> =>
        hostLeavesByTab(
          (
            await host.client.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
              worktree
            })
          ).result
        )

      await page.evaluate((id) => window.__store?.getState().setActiveWorktree(id), worktreeId)
      await expect(page.locator(PANE)).toHaveCount(1, { timeout: 60_000 })
      await waitForBoundPanes(page, 1)
      const sourceTabId = await page.evaluate(() => window.__store?.getState().activeTabId ?? '')
      const firstLeafId = await page.locator(PANE).first().getAttribute('data-leaf-id')
      await splitActiveTerminalPane(page, 'vertical')
      await waitForBoundPanes(page, 2)
      const leafIds = await page
        .locator(PANE)
        .evaluateAll((panes) => panes.map((pane) => pane.getAttribute('data-leaf-id') ?? ''))
      const movedLeafId = leafIds.find((id) => id !== firstLeafId)!
      await expect
        .poll(async () => Object.values(await readHost()).map((leaves) => leaves.length), {
          timeout: 30_000
        })
        .toEqual([2])

      await dragPaneOutToTabStrip(page, worktreeId, movedLeafId)
      await expect(page.locator(TAB)).toHaveCount(2, { timeout: 15_000 })

      // The server holds the moved leaf alone in another tab.
      await expect
        .poll(
          async () =>
            Object.values(await readHost())
              .map((leaves) => leaves.toSorted().join(','))
              .toSorted(),
          { timeout: 15_000, message: 'the server never moved the pane' }
        )
        .toEqual([firstLeafId, movedLeafId].toSorted())
      const hostTabOfMovedLeaf = Object.entries(await readHost()).find(([, leaves]) =>
        leaves.includes(movedLeafId)
      )?.[0]
      const { terminals } = (
        await host.client.call<RuntimeTerminalListResult>('terminal.list', { worktree })
      ).result
      expect(terminals.find((terminal) => terminal.leafId === movedLeafId)?.tabId).toBe(
        hostTabOfMovedLeaf
      )

      // Switching back to the source tab must not pull the pane back into its split.
      await page.locator(`${TAB}[data-tab-id="${sourceTabId}"]`).click()
      await page.waitForTimeout(2_000)
      await expect(page.locator(TAB)).toHaveCount(2)
      await expect(page.locator(PANE)).toHaveCount(1)
      await expect(page.locator(`${PANE}[data-leaf-id="${movedLeafId}"]`)).toHaveCount(0)
    } finally {
      await desktop.dispose()
    }
  } finally {
    await host.dispose()
  }
})
