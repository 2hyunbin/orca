/**
 * Layout rework P3 baseline, regression #23429 (fixed by #26022): terminals whose PTY ids carry
 * `@@` (daemon-minted: the paired desktop's own tab and a CLI `terminal.create`) stay listed after
 * `orca serve` restarts, beside a serve-minted one. Records the server's tab list, live terminals
 * and published layout before and after the restart, and what the desktop draws once reconnected.
 */
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import {
  expectLayoutCompatBaseline,
  IdLabels,
  publishedLayoutShape,
  readPublishedLayout,
  readSessionTabs,
  readSettled,
  readTerminals,
  sessionTabsShape
} from './helpers/layout-compat-baseline'
import type { RuntimeTerminalCreate } from '../../src/shared/runtime-terminal-contracts'

const PANE = '.pane[data-leaf-id]:visible'
const TAB = '[data-testid="sortable-tab"]'

test('serve-restart-keeps-@@-terminals: desktop, CLI and serve terminals survive a serve restart', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const host = await launchHeadlessPairedRuntimeHost({ pinnedServePort: true })
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    const desktop = await launchPairedElectronClient(host.offer, testInfo, 'serve restart')
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
      // Opening an empty server workspace makes the desktop create its first terminal there.
      await page.evaluate((id) => window.__store?.getState().setActiveWorktree(id), worktreeId)
      await expect(page.locator(PANE)).toHaveCount(1, { timeout: 60_000 })
      const cli = await host.client.call<{ terminal: RuntimeTerminalCreate }>('terminal.create', {
        worktree,
        title: 'cli-created'
      })
      // The CLI's tab is placed after its reply; wait for it so the tab order is fixed.
      await expect
        .poll(async () => (await readSessionTabs(host.client, worktree)).tabs.length)
        .toBe(2)
      const served = await host.client.call<{ tab: { parentTabId: string } }>(
        'session.tabs.createTerminal',
        { worktree, activate: false, select: false, navigation: 'caller' }
      )

      const labels = new IdLabels()
      const read = async () => ({
        server: sessionTabsShape(await readSessionTabs(host.client, worktree), labels),
        terminals: await readTerminals(host.client, worktree, labels),
        published: publishedLayoutShape(
          await readPublishedLayout(host.offer.pairingUrl, worktreeId),
          labels
        ),
        desktopTabs: await page.locator(TAB).count(),
        desktopPanes: await page.locator(PANE).count()
      })
      await expect
        .poll(async () => (await readSessionTabs(host.client, worktree)).tabs.length)
        .toBe(3)
      const before = await readSettled(read)

      await host.restartServeProcess()
      await expect(page.locator(TAB)).not.toHaveCount(0, { timeout: 60_000 })
      const settled = await readSettled(read)
      // Main races here: after the restart, the CLI's tab comes second or last, in session.tabs.list
      // and in the published layout alike (both seen in repeated runs). Recorded order-free, so the
      // baseline holds membership; the rework makes this order exact.
      const byTab = (a: { tab: string | null }, b: { tab: string | null }) =>
        String(a.tab).localeCompare(String(b.tab))
      const after = {
        ...settled,
        server: {
          ...settled.server,
          groups: settled.server.groups.map((group) => ({ ...group, tabs: group.tabs.toSorted() })),
          rows: settled.server.rows.toSorted(byTab)
        },
        published: settled.published && {
          groups: settled.published.groups.map((group) => group.toSorted()),
          tabs: settled.published.tabs.toSorted(byTab)
        }
      }

      await expectLayoutCompatBaseline(testInfo, 'serve-restart-keeps-@@-terminals', {
        created: {
          cli: labels.pty(cli.result.terminal.ptyId),
          serve: labels.label('tab', served.result.tab.parentTabId)
        },
        before,
        after
      })
    } finally {
      await desktop.dispose()
    }
  } finally {
    await host.dispose()
  }
})
