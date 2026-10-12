/**
 * Owner report: on a remote server, the desktop's tab strip suddenly regroups by kind, browsers on
 * the left and terminals on the right. A desktop paired to a headless serve opens a terminal, a
 * browser it hosts itself, and another terminal; the strip it draws and the server's own list must
 * keep that order, also across a serve restart.
 */
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { cleanupE2EDaemons } from './helpers/electron-process-shutdown'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  openClientHostedFixturePage,
  selectPairedWorktreeGroup,
  startClientHostedMarkerFixture,
  waitForPairedWorktreeId
} from './helpers/client-hosted-browser-fixture'
import {
  refreshAuthorityRuntimeId,
  waitForRelaunchedRuntime
} from './helpers/client-hosted-runtime-relaunch'
import { readSessionTabs } from './helpers/layout-compat-baseline'
import { toHostSessionTabId } from '../../src/shared/terminal-surface-id'

/** The desktop's groups, each tab named by what it mirrors: a server terminal or a host page. */
async function desktopStrip(page: Page, worktreeId: string): Promise<string[][]> {
  const groups = await page.evaluate((id) => {
    const state = window.__store?.getState()
    const tabs = state?.unifiedTabsByWorktree[id] ?? []
    return (state?.groupsByWorktree[id] ?? []).map((group) =>
      group.tabOrder.map((tabId) => {
        const tab = tabs.find((candidate) => candidate.id === tabId)
        if (tab?.contentType !== 'browser') {
          return { terminal: tabId }
        }
        const pageId = state?.browserPagesByWorkspace[tab.entityId]?.[0]?.id
        const handle = pageId ? state?.remoteBrowserPageHandlesByPageId[pageId] : undefined
        return { page: handle?.remotePageId ?? pageId ?? tab.entityId }
      })
    )
  }, worktreeId)
  return groups.map((group) =>
    group.map((entry) => ('page' in entry ? entry.page : toHostSessionTabId(entry.terminal)))
  )
}

test('a paired desktop keeps a mixed terminal and browser tab order', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(420_000)
  const fixture = await startClientHostedMarkerFixture()
  const host = await launchHeadlessPairedRuntimeHost({ pinnedServePort: true })
  let client: PairedElectronClient | null = null
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    client = await launchPairedElectronClient(host.offer, testInfo, 'mixed tab order')
    const worktreeId = await waitForPairedWorktreeId(client.page, testRepoPath)
    const worktree = `id:${worktreeId}`
    await selectPairedWorktreeGroup(client.page, client.environmentId, worktreeId)
    // Opening an empty server workspace makes the desktop create its first terminal there.
    await expect
      .poll(async () => (await desktopStrip(client!.page, worktreeId)).flat().length, {
        timeout: 60_000
      })
      .toBe(1)
    const [first] = (await desktopStrip(client.page, worktreeId)).flat()
    const browser = (await openClientHostedFixturePage(client, worktreeId, fixture.markerUrl))
      .remotePageId
    const second = (
      await host.client.call<{ tab: { parentTabId: string } }>('session.tabs.createTerminal', {
        worktree,
        activate: false
      })
    ).result.tab.parentTabId

    const findings: string[] = []
    const expectOrder = async (step: string, expected: string[]): Promise<void> => {
      const reads = {
        desktop: async () => desktopStrip(client!.page, worktreeId),
        server: async () =>
          ((await readSessionTabs(host.client, worktree)).tabGroups ?? []).map(
            (group) => group.tabOrder
          )
      }
      for (const [view, read] of Object.entries(reads)) {
        let strip: string[][] = []
        await expect
          .poll(async () => JSON.stringify((strip = await read())), { timeout: 60_000 })
          .toBe(JSON.stringify([expected]))
          .catch(() => undefined)
        if (JSON.stringify(strip) !== JSON.stringify([expected])) {
          const name = (id: string) =>
            id === first ? 'T1' : id === browser ? 'B' : id === second ? 'T2' : id
          findings.push(`${step}, ${view}: ${JSON.stringify(strip.map((g) => g.map(name)))}`)
        }
      }
    }
    await expectOrder('terminal, browser, terminal', [first!, browser, second])

    const runtimeIdBeforeRestart = await refreshAuthorityRuntimeId(client)
    await host.restartServeProcess()
    await waitForRelaunchedRuntime(client, runtimeIdBeforeRestart!)
    await selectPairedWorktreeGroup(client.page, client.environmentId, worktreeId)
    await expectOrder('serve restart', [first!, browser, second])

    expect(findings).toEqual([])
  } finally {
    if (client) {
      await cleanupE2EDaemons(client.userDataDir).catch(() => undefined)
      await client.dispose()
    }
    await host.dispose()
    await fixture.close()
  }
})
