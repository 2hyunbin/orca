/**
 * Owner report: in a remote workspace whose browser tabs run on the desktop, "either the browser
 * tabs all go to the very left, or my agent terminals are going to the right." A desktop paired to
 * a headless serve opens a terminal and a page it hosts itself, then the server opens a terminal;
 * the desktop's strip must keep that order through each trigger below. Every strip the desktop
 * draws is recorded, so a transient regroup shows even when the final strip recovers.
 */
import { mkdirSync } from 'node:fs'
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
import { startFreezableTcpProxy, type FreezableTcpProxy } from './helpers/freezable-tcp-proxy'
import { readSessionTabs } from './helpers/layout-compat-baseline'
import { decodePairingOffer, encodePairingOffer } from '../../src/shared/pairing'
import { toHostSessionTabId } from '../../src/shared/terminal-surface-id'

type Strip = string[][]

declare global {
  /** Every distinct strip the desktop drew since the last read. */
  var __mixedTabOrderStrips: Strip[] | undefined
}

/** Records every distinct strip the desktop draws for the worktree, as host tab and page ids. */
async function recordDesktopStrips(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((id) => {
    const store = window.__store!
    const read = (): Strip => {
      const state = store.getState()
      const tabs = state.unifiedTabsByWorktree[id] ?? []
      return (state.groupsByWorktree[id] ?? []).map((group) =>
        group.tabOrder.map((tabId) => {
          const tab = tabs.find((candidate) => candidate.id === tabId)
          if (tab?.contentType !== 'browser') {
            return tabId
          }
          const pageId = state.browserPagesByWorkspace[tab.entityId]?.[0]?.id
          const handle = pageId ? state.remoteBrowserPageHandlesByPageId[pageId] : undefined
          return `page:${handle?.remotePageId ?? pageId ?? tab.entityId}`
        })
      )
    }
    const strips: Strip[] = [read()]
    window.__mixedTabOrderStrips = strips
    store.subscribe(() => {
      const next = read()
      if (JSON.stringify(next) !== JSON.stringify(strips.at(-1))) {
        strips.push(next)
      }
    })
  }, worktreeId)
}

/** The strips recorded since the last call, terminal ids mapped to the host tabs they mirror. */
async function takeDesktopStrips(page: Page): Promise<Strip[]> {
  const strips = await page.evaluate(() => {
    const strips = window.__mixedTabOrderStrips ?? []
    return strips.splice(0, strips.length - 1).concat(strips)
  })
  return strips.map((strip) =>
    strip.map((group) =>
      group.map((id) => (id.startsWith('page:') ? id.slice(5) : toHostSessionTabId(id)))
    )
  )
}

const TRIGGERS = [
  'network outage',
  'silent network outage',
  'desktop reload',
  'serve restart',
  'workspace switch',
  'sleep and wake'
] as const

for (const trigger of TRIGGERS) {
  test(`a paired desktop keeps its mixed tab order through a ${trigger}`, async ({
    testRepoPath
  }, testInfo) => {
    test.setTimeout(420_000)
    const fixture = await startClientHostedMarkerFixture()
    const host = await launchHeadlessPairedRuntimeHost({ pinnedServePort: true })
    let client: PairedElectronClient | null = null
    let proxy: FreezableTcpProxy | null = null
    try {
      await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
      const decoded = decodePairingOffer(host.offer.pairingUrl)
      if (!('endpoint' in decoded)) {
        throw new Error('expected a direct pairing offer')
      }
      const endpoint = new URL(decoded.endpoint)
      proxy = await startFreezableTcpProxy(endpoint.hostname, Number(endpoint.port))
      endpoint.port = String(proxy.port)
      client = await launchPairedElectronClient(
        { pairingUrl: encodePairingOffer({ ...decoded, endpoint: endpoint.toString() }) },
        testInfo,
        `mixed tab order ${trigger}`
      )
      const worktreeId = await waitForPairedWorktreeId(client.page, testRepoPath)
      const worktree = `id:${worktreeId}`
      await selectPairedWorktreeGroup(client.page, client.environmentId, worktreeId)
      await recordDesktopStrips(client.page, worktreeId)
      // Opening an empty server workspace makes the desktop create its first terminal there.
      await expect
        .poll(async () => (await takeDesktopStrips(client!.page)).at(-1)?.flat().length, {
          timeout: 60_000
        })
        .toBe(1)
      const [first] = (await takeDesktopStrips(client.page)).at(-1)!.flat()
      const browser = (await openClientHostedFixturePage(client, worktreeId, fixture.markerUrl))
        .remotePageId
      // The server opens the agent's terminal after the browser.
      const agent = (
        await host.client.call<{ tab: { parentTabId: string } }>('session.tabs.createTerminal', {
          worktree,
          activate: false
        })
      ).result.tab.parentTabId
      const name = (id: string) =>
        id === first ? 'T1' : id === browser ? 'B' : id === agent ? 'agent' : id
      const named = (strips: Strip[]) =>
        strips.map((strip) => JSON.stringify(strip.map((group) => group.map(name))))
      const expected = JSON.stringify([['T1', 'B', 'agent']])

      const findings: string[] = []
      const settle = async (step: string, transientsCount = true): Promise<void> => {
        const history: string[] = []
        const take = async (): Promise<string | undefined> => {
          for (const strip of named(await takeDesktopStrips(client!.page))) {
            if (strip !== history.at(-1)) {
              history.push(strip)
            }
          }
          return history.at(-1)
        }
        await expect
          .poll(take, { timeout: 90_000 })
          .toBe(expected)
          .catch(() => undefined)
        const server = (await readSessionTabs(host.client, worktree)).tabGroups ?? []
        console.log(
          `[mixed-tab-order] ${trigger} / ${step}: desktop ${history.join(' -> ')}; server ${JSON.stringify(server.map((group) => group.tabOrder.map(name)))}`
        )
        if (
          history.at(-1) !== expected ||
          (transientsCount && history.some((s) => s !== expected))
        ) {
          findings.push(`${step}: desktop drew ${history.join(' -> ')}`)
        }
      }
      await settle('server opens an agent terminal after the browser', false)

      if (trigger === 'network outage' || trigger === 'silent network outage') {
        // Past the lease grace, so the host drops the desktop's lease: a reset starts the 15 s grace
        // at once; a silent drop first needs the host's heartbeat to reap the socket.
        proxy.cut(trigger === 'network outage' ? 'reset' : 'silent')
        await new Promise((resolve) =>
          setTimeout(resolve, trigger === 'network outage' ? 25_000 : 100_000)
        )
        proxy.restore()
      } else if (trigger === 'workspace switch') {
        const other = testInfo.outputPath('other-workspace')
        mkdirSync(other, { recursive: true })
        await host.client.call('repo.add', { path: other, kind: 'folder' })
        const otherId = await waitForPairedWorktreeId(client.page, other)
        await selectPairedWorktreeGroup(client.page, client.environmentId, otherId)
        await client.page.waitForTimeout(2_000)
        await selectPairedWorktreeGroup(client.page, client.environmentId, worktreeId)
      } else if (trigger === 'sleep and wake') {
        // The worktree's terminals stop, as when agents hibernate; opening a tab starts it again.
        await host.client.call('worktree.sleep', { worktree })
        for (const tabId of [first!, agent]) {
          await host.client.call('session.tabs.activate', { worktree, tabId })
        }
      } else if (trigger === 'desktop reload') {
        await client.page.reload()
        await client.page.waitForFunction(
          () => window.__store?.getState().workspaceSessionReady === true
        )
        await selectPairedWorktreeGroup(client.page, client.environmentId, worktreeId)
        await recordDesktopStrips(client.page, worktreeId)
      } else {
        const runtimeId = await refreshAuthorityRuntimeId(client)
        await host.restartServeProcess()
        await waitForRelaunchedRuntime(client, runtimeId!)
      }
      await settle(trigger)

      expect(findings).toEqual([])
    } finally {
      if (client) {
        await cleanupE2EDaemons(client.userDataDir).catch(() => undefined)
        await client.dispose()
      }
      await proxy?.close()
      await host.dispose()
      await fixture.close()
    }
  })
}
