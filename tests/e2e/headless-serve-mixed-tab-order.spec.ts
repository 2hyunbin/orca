/**
 * Owner report: on a remote server the tab strip suddenly regroups by kind. A headless serve with
 * terminals and a browser in one group must keep the order the tabs were opened in across a tab
 * tap, a create, a close and a restart, as paired clients and the server's layout stream see it.
 *
 * Run:
 *   ORCA_BACKGROUND_LAUNCH=1 SKIP_BUILD=1 pnpm exec playwright test \
 *     tests/e2e/headless-serve-mixed-tab-order.spec.ts --config tests/playwright.config.ts \
 *     --project electron-headless --workers=1
 */

import type { RuntimeClient } from '../../src/cli/runtime/client'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-session-contracts'
import { expect, test } from './helpers/orca-app'
import {
  addRepoWorktree,
  cliClient,
  pairedClient,
  startHeadlessOracleHost
} from './helpers/headless-layout-oracle-hosts'

/** Each group's tab order as a paired client lists it, with each tab named by its kind. */
async function strip(client: RuntimeClient, worktree: string): Promise<string[][]> {
  const { result } = await client.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
    worktree
  })
  return (result.tabGroups ?? []).map((group) => group.tabOrder)
}

test('headless serve keeps a mixed terminal and browser tab order', async () => {
  test.setTimeout(300_000)
  const host = await startHeadlessOracleHost('electron')
  try {
    const cli = cliClient(host)
    const a = pairedClient(host, 'a')
    const worktreeId = await addRepoWorktree(host, cli)
    const worktree = `id:${worktreeId}`
    const createTerminal = async (): Promise<string> =>
      (
        await a.call<{ tab: { parentTabId: string } }>('session.tabs.createTerminal', {
          worktree
        })
      ).result.tab.parentTabId
    const createBrowser = async (): Promise<string> => {
      const before = new Set((await strip(a, worktree)).flat())
      await a.call('browser.tabCreate', { worktree, url: 'about:blank' })
      let created: string | undefined
      await expect
        .poll(
          async () => (created = (await strip(a, worktree)).flat().find((id) => !before.has(id))),
          { timeout: 30_000, message: 'browser tab never listed' }
        )
        .toBeDefined()
      return created!
    }
    const findings: string[] = []
    const expectStrip = async (step: string, expected: string[][]): Promise<void> => {
      let listed: string[][] = []
      await expect
        .poll(async () => JSON.stringify((listed = await strip(a, worktree))), { timeout: 15_000 })
        .toBe(JSON.stringify(expected))
        .catch(() => undefined)
      if (JSON.stringify(listed) !== JSON.stringify(expected)) {
        findings.push(`${step}: ${JSON.stringify(listed)}, expected ${JSON.stringify(expected)}`)
      }
    }

    const first = await createTerminal()
    const browser = await createBrowser()
    const second = await createTerminal()
    await expectStrip('create terminal, browser, terminal', [[first, browser, second]])

    await a.call('session.tabs.activate', { worktree, tabId: first })
    await expectStrip('tap the first terminal', [[first, browser, second]])

    await a.call('session.tabs.activate', { worktree, tabId: browser })
    await expectStrip('tap the browser', [[first, browser, second]])

    const third = await createTerminal()
    await expectStrip('create another terminal', [[first, browser, second, third]])

    await a.call('session.tabs.close', { worktree, tabId: second, reason: 'user' })
    await expectStrip('close a terminal', [[first, browser, third]])

    await host.restart()
    await expect
      .poll(async () => (await strip(a, worktree)).flat().length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2)
    // Whether an offscreen page outlives the serve process is not what this checks; only order is.
    const listed = new Set((await strip(a, worktree)).flat())
    await expectStrip('warm restart', [[first, browser, third].filter((id) => listed.has(id))])

    expect(findings).toEqual([])
  } finally {
    await host.dispose()
  }
})
