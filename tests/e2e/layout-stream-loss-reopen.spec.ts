/**
 * The window's layout stream from main ends mid-session and reopens (layout-owner build only).
 * The window keeps working through it: no tab or pane is lost or shown twice, main's own changes
 * show again once the stream is back, the window's later changes apply, and a relaunch keeps them.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { ensureTerminalVisible, switchToWorktree, waitForSessionReady } from './helpers/store'
import { splitActiveTerminalPane, waitForActiveTerminalManager } from './helpers/terminal'

const LAYOUT_OWNER_BUILD = existsSync(
  path.join(process.cwd(), 'out', 'main', 'ORCA_LAYOUT_OWNER_MAIN')
)

/** Terminal tab id → its pane ids in tree order, in tab-bar order. */
type TerminalLayout = [tabId: string, paneIds: string[]][]

type Launched = Awaited<ReturnType<ReturnType<typeof createRestartSession>['launch']>>

function leafIds(root: unknown): string[] {
  if (!root || typeof root !== 'object') {
    return []
  }
  if ('leafId' in root && typeof root.leafId === 'string') {
    return [root.leafId]
  }
  const first = 'first' in root ? root.first : null
  const second = 'second' in root ? root.second : null
  return [...leafIds(first), ...leafIds(second)]
}

/** What the window draws for the workspace's terminal tabs. */
async function readWindowLayout(page: Page, worktreeId: string): Promise<TerminalLayout> {
  const drawn = await page.evaluate((id) => {
    const state = window.__store!.getState()
    const terminalIds = new Set((state.tabsByWorktree[id] ?? []).map((tab) => tab.id))
    // Every drawn row, so a duplicate row under one id still counts twice.
    const rows = (state.tabsByWorktree[id] ?? []).map((tab) => tab.id)
    const tabBar = (state.unifiedTabsByWorktree[id] ?? [])
      .filter((entry) => entry.contentType === 'terminal' && terminalIds.has(entry.entityId))
      .map((entry) => entry.entityId)
    const roots = Object.fromEntries(
      rows.map((tabId) => [tabId, state.terminalLayoutsByTabId[tabId]?.root ?? null])
    )
    return { rows, tabBar, roots }
  }, worktreeId)
  if (drawn.rows.length !== drawn.tabBar.length) {
    // A row without its tab-bar entry, or the reverse: surfaces as a mismatch, not a pass.
    return [
      ['rows', drawn.rows],
      ['tabBar', drawn.tabBar]
    ]
  }
  return drawn.tabBar.map((tabId) => [tabId, leafIds(drawn.roots[tabId])])
}

/** What main holds for the workspace, read from a stream of the test's own. */
async function readMainLayout(page: Page, worktreeId: string): Promise<TerminalLayout> {
  const tabs = await page.evaluate(
    (id) =>
      new Promise<{ entityId: string; root: unknown }[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('main sent no layout snapshot')), 10_000)
        let handle: { unsubscribe: () => void } | null = null
        let answer: { entityId: string; root: unknown }[] | null = null
        const finish = (): void => {
          if (handle && answer) {
            clearTimeout(timer)
            handle.unsubscribe()
            resolve(answer)
          }
        }
        void window.api.runtime
          .subscribe({ method: 'layout.subscribe', params: { workspaces: [id] } }, (response) => {
            const frame = response.ok ? response.result : null
            if (!frame || typeof frame !== 'object' || !('type' in frame)) {
              return
            }
            if (frame.type === 'snapshot' && 'workspaces' in frame && !answer) {
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: main's published snapshot shape; a mismatch fails the comparison below.
              const entries = frame.workspaces as {
                key: string
                layout: { tabs: { kind: string; entityId: string; terminal?: { root: unknown } }[] }
              }[]
              const layout = entries.find((entry) => entry.key === id)?.layout
              answer = (layout?.tabs ?? [])
                .filter((tab) => tab.kind === 'terminal')
                .map((tab) => ({ entityId: tab.entityId, root: tab.terminal?.root ?? null }))
              finish()
            }
          })
          .then((opened) => {
            handle = opened
            finish()
          }, reject)
      }),
    worktreeId
  )
  return tabs.map((tab) => [tab.entityId, leafIds(tab.root)])
}

/** Polls until the window and main agree on `expected` three reads in a row: a late duplicate fails. */
async function expectSettled(
  page: Page,
  worktreeId: string,
  expected: (layout: TerminalLayout) => void
): Promise<TerminalLayout> {
  let streak = 0
  let settled: TerminalLayout = []
  await expect
    .poll(
      async () => {
        const [windowLayout, mainLayout] = await Promise.all([
          readWindowLayout(page, worktreeId),
          readMainLayout(page, worktreeId)
        ])
        const same = JSON.stringify(windowLayout) === JSON.stringify(mainLayout)
        streak = same ? streak + 1 : 0
        settled = windowLayout
        return streak >= 3 ? 'settled' : { windowLayout, mainLayout }
      },
      { timeout: 30_000, intervals: [500] }
    )
    .toBe('settled')
  expected(settled)
  return settled
}

function tabIds(layout: TerminalLayout): string[] {
  return layout.map(([tabId]) => tabId)
}

function paneCount(layout: TerminalLayout, tabId: string): number {
  return layout.find(([id]) => id === tabId)?.[1].length ?? 0
}

/** A terminal main starts itself, as the CLI's create does: only the stream shows it. */
async function createMainTerminal(
  page: Page,
  worktreeId: string
): Promise<{ tabId: string; handle: string }> {
  const reply = await page.evaluate(
    (id) =>
      window.api.runtime.call({
        method: 'terminal.create',
        params: {
          worktree: `id:${id}`,
          command: 'sleep 600',
          focus: false,
          activate: false,
          presentation: 'background'
        }
      }),
    worktreeId
  )
  const result = reply.ok ? reply.result : null
  const terminal =
    result && typeof result === 'object' && 'terminal' in result ? result.terminal : null
  const tabId =
    terminal && typeof terminal === 'object' && 'tabId' in terminal ? terminal.tabId : null
  const handle =
    terminal && typeof terminal === 'object' && 'handle' in terminal ? terminal.handle : null
  if (typeof tabId !== 'string' || typeof handle !== 'string') {
    throw new Error(`terminal.create gave no tab: ${JSON.stringify(reply).slice(0, 300)}`)
  }
  return { tabId, handle }
}

/** A split main makes itself, as the CLI's split does. */
async function splitMainTerminal(page: Page, handle: string): Promise<void> {
  const reply = await page.evaluate(
    (terminal) =>
      window.api.runtime.call({
        method: 'terminal.split',
        params: { terminal, direction: 'vertical', command: 'sleep 600' }
      }),
    handle
  )
  if (!reply.ok) {
    throw new Error(`terminal.split failed: ${JSON.stringify(reply).slice(0, 300)}`)
  }
}

function watchStreamStops(page: Page): string[] {
  const stops: string[] = []
  page.on('console', (message) => {
    if (message.text().includes('[layout-owner] layout stream stopped')) {
      stops.push(message.text())
    }
  })
  return stops
}

function watchRefusals(page: Page, refusals: string[]): void {
  page.on('console', (message) => {
    if (/\[layout-owner\].*(refused|failed)/.test(message.text())) {
      refusals.push(message.text())
    }
  })
}

async function openWorkspace(first: Launched, repoPath: string): Promise<string> {
  await waitForSessionReady(first.page)
  const worktreeId = await attachRepoAndOpenTerminal(first.page, repoPath)
  await ensureTerminalVisible(first.page)
  await waitForActiveTerminalManager(first.page, 30_000)
  await expect
    .poll(() => first.page.evaluate(() => typeof window.__endLocalLayoutStreamE2E), {
      timeout: 15_000,
      message: 'the window never opened its layout stream'
    })
    .toBe('function')
  return worktreeId
}

/**
 * Ends the stream, opens a tab while it is down, then has main start a split terminal of its own,
 * which shows only once the stream is back. Returns the tab ids in the order made.
 */
async function loseStreamAndChange(
  page: Page,
  worktreeId: string,
  stops: string[]
): Promise<{ firstTab: string; duringLoss: string; mainTab: string }> {
  const before = await expectSettled(page, worktreeId, (layout) => expect(layout).toHaveLength(1))
  const firstTab = before[0]![0]
  const duringLoss = await page.evaluate(async (id) => {
    const ended = await window.__endLocalLayoutStreamE2E!()
    // In the same task as the end, so the tab opens before any reopen.
    const state = window.__store!.getState()
    const tab = state.createTab(id)
    state.setActiveTab(tab.id)
    return { ended, tabId: tab.id }
  }, worktreeId)
  expect(duringLoss.ended).toMatchObject({ ok: true })
  await expect.poll(() => stops.length, { message: 'the stream never stopped' }).toBe(1)

  const mainTerminal = await createMainTerminal(page, worktreeId)
  await splitMainTerminal(page, mainTerminal.handle)
  await expectSettled(page, worktreeId, (layout) => {
    expect(tabIds(layout)).toEqual([firstTab, duringLoss.tabId, mainTerminal.tabId])
    expect(paneCount(layout, mainTerminal.tabId)).toBe(2)
  })
  return { firstTab, duringLoss: duringLoss.tabId, mainTab: mainTerminal.tabId }
}

test.describe('the window layout stream ends mid-session', () => {
  test.skip(!LAYOUT_OWNER_BUILD, 'layout-owner build only: other builds open no layout stream')

  test('reopens with no tab or pane lost or doubled, and later changes apply', async ({
    testRepoPath
  }, testInfo) => {
    const session = createRestartSession(testInfo)
    const refusals: string[] = []
    let app: Launched['app'] | undefined
    try {
      const first = await session.launch()
      app = first.app
      const stops = watchStreamStops(first.page)
      watchRefusals(first.page, refusals)
      const worktreeId = await openWorkspace(first, testRepoPath)
      const { firstTab, duringLoss, mainTab } = await loseStreamAndChange(
        first.page,
        worktreeId,
        stops
      )

      // The window's own changes after the reopen: a close, a new tab and a split.
      await first.page.evaluate((tabId) => window.__store!.getState().closeTab(tabId), duringLoss)
      const afterReopen = await first.page.evaluate((id) => {
        const state = window.__store!.getState()
        const tab = state.createTab(id)
        state.setActiveTab(tab.id)
        return tab.id
      }, worktreeId)
      await waitForActiveTerminalManager(first.page, 30_000)
      await splitActiveTerminalPane(first.page, 'vertical')
      await expectSettled(first.page, worktreeId, (layout) => {
        expect(tabIds(layout)).toEqual([firstTab, mainTab, afterReopen])
        expect(paneCount(layout, afterReopen)).toBe(2)
        expect(paneCount(layout, mainTab)).toBe(2)
      })
      expect(stops).toHaveLength(1)
      expect(refusals).toEqual([])
    } finally {
      await session.dispose(app)
    }
  })

  test('a change made after the stream ended survives a relaunch', async ({
    testRepoPath
  }, testInfo) => {
    const session = createRestartSession(testInfo)
    const refusals: string[] = []
    let app: Launched['app'] | undefined
    try {
      const first = await session.launch()
      app = first.app
      const stops = watchStreamStops(first.page)
      watchRefusals(first.page, refusals)
      const worktreeId = await openWorkspace(first, testRepoPath)
      const { firstTab, duringLoss, mainTab } = await loseStreamAndChange(
        first.page,
        worktreeId,
        stops
      )

      // After the reopen: the first tab closes and the tab opened during the loss splits.
      await first.page.evaluate((tabId) => window.__store!.getState().closeTab(tabId), firstTab)
      await first.page.evaluate(
        (tabId) => window.__store!.getState().setActiveTab(tabId),
        duringLoss
      )
      await waitForActiveTerminalManager(first.page, 30_000)
      await splitActiveTerminalPane(first.page, 'vertical')
      const beforeQuit = await expectSettled(first.page, worktreeId, (layout) => {
        expect(tabIds(layout)).toEqual([duringLoss, mainTab])
        expect(paneCount(layout, duringLoss)).toBe(2)
      })
      // Long enough for the window's debounced save to land.
      await first.page.waitForTimeout(2_000)
      await session.close(app)
      app = undefined

      const second = await session.launch()
      app = second.app
      watchRefusals(second.page, refusals)
      await waitForSessionReady(second.page)
      await switchToWorktree(second.page, worktreeId)
      await expectSettled(second.page, worktreeId, (layout) => {
        expect(tabIds(layout)).toEqual(tabIds(beforeQuit))
        expect(paneCount(layout, duringLoss)).toBe(2)
        expect(paneCount(layout, mainTab)).toBe(2)
      })
      expect(refusals).toEqual([])
    } finally {
      await session.dispose(app)
    }
  })
})
