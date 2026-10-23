/**
 * A moved project's terminals, as the desktop sees them once the WSL host owns them: the host
 * serves the workspace, its panes were put to sleep (so the host holds only a stored scrollback
 * snapshot and no live terminal), and this desktop has never painted them. Opening the tab must
 * show the history the pane had before it slept.
 *
 * Topology: the headed fixture app stands in for the distro's orcad; a paired desktop client
 * stands in for the moving desktop. The host's own sleep writes the snapshot the move would.
 *
 * Run:
 *   pnpm exec playwright test tests/e2e/wsl-move-host-pane-history.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import {
  callEnvironment,
  createPairedHostTerminal,
  openPairedClientTab,
  readPairedPaneContent
} from './helpers/paired-host-terminal'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { waitForSessionReady } from './helpers/store'
import {
  createMovedRepo,
  MOVED_BROWSER_URL,
  MOVED_TAB,
  seedImportedMovedTab
} from './helpers/wsl-moved-host-profile'
import { quotePosixShell } from '../../src/shared/shell-argument-quoting'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'

const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-moved-history-'))
const fixturePath = path.join(scratch, 'history-terminal.mjs')
writeFileSync(
  fixturePath,
  [
    'const marker = process.argv[2]',
    'for (let i = 0; i < 40; i += 1) process.stdout.write(`${marker} line ${i}\\r\\n`)',
    'process.stdin.resume()'
  ].join('\n')
)

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function fixtureCommand(marker: string): string {
  return [process.execPath, fixturePath, marker].map(quotePosixShell).join(' ')
}

type ClientTabState = {
  refs: Record<string, string>
  ptyIds: Record<string, string>
  buffers: number
  localOnly: number
}

async function readClientTabState(page: Page, tabId: string): Promise<ClientTabState> {
  return page.evaluate((id) => {
    const state = window.__store?.getState()
    const layout = state?.terminalLayoutsByTabId?.[id]
    return {
      refs: { ...layout?.scrollbackRefsByLeafId },
      ptyIds: { ...layout?.ptyIdsByLeafId },
      buffers: Object.values(layout?.buffersByLeafId ?? {}).join('').length,
      localOnly: Object.values(state?.localOnlyScrollbackByTabId?.[id] ?? {}).join('').length
    }
  }, tabId)
}

test('a slept host pane this desktop never painted shows its history when opened', async ({
  orcaPage
}, testInfo) => {
  test.skip(process.platform === 'win32', 'POSIX fixture command')
  test.setTimeout(600_000)
  const worktreeId = await orcaPage.evaluate(() => {
    const id = window.__store?.getState().activeWorktreeId
    if (!id) {
      throw new Error('host has no active worktree')
    }
    return id
  })
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedElectronClient(offer, testInfo, 'moved-history')
  try {
    await expect
      .poll(
        () =>
          client.page.evaluate(
            (id) =>
              Boolean(
                window.__store
                  ?.getState()
                  .allWorktrees()
                  .some((worktree) => worktree.id === id)
              ),
            worktreeId
          ),
        { timeout: 60_000 }
      )
      .toBe(true)
    const marker = `moved-${randomUUID()}`
    const terminal = await createPairedHostTerminal(
      client.page,
      client.environmentId,
      worktreeId,
      fixtureCommand(marker)
    )
    // Let the host's terminal print before it sleeps; the client never mounts the tab.
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    await callEnvironment(client.page, client.environmentId, 'worktree.sleep', {
      worktree: `id:${worktreeId}`
    })
    await client.page.evaluate((id) => {
      const state = window.__store?.getState()
      state?.setActiveView('terminal')
      state?.setActiveWorktree(id)
    }, worktreeId)
    console.log(
      `[moved-history] before-open ${JSON.stringify(await readClientTabState(client.page, terminal.webTabId))}`
    )
    await openPairedClientTab(client.page, worktreeId, terminal.webTabId)
    await new Promise((resolve) => setTimeout(resolve, 8_000))
    console.log(
      `[moved-history] after-open ${JSON.stringify(await readClientTabState(client.page, terminal.webTabId))}`
    )
    const content = await readPairedPaneContent(client.page, terminal.webTabId)
    console.log(`[moved-history] content-tail ${JSON.stringify(content.slice(-400))}`)
    expect(content).toContain(`${marker} line 39`)
  } finally {
    await client.dispose()
  }
})

type ImportedOutcome = {
  marker: string
  /** The pane's buffer when first opened, then after each reload and reopen. */
  contents: string[]
  browserUrls: string[]
}

/** `lines` numbered history lines under `marker`, as a shell printed them. */
function numberedHistory(marker: string, lines: number): string {
  const rows = Array.from({ length: lines }, (_, index) => `${historyLine(marker, index + 1)}\r\n`)
  return `${marker}\r\n${rows.join('')}`
}

function historyLine(marker: string, line: number): string {
  return `${marker.slice(9, 17)}L${String(line).padStart(4, '0')} line`
}

async function openMovedTab(page: Page, worktreeId: string, webTabId: string): Promise<string> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) =>
            Boolean(
              window.__store
                ?.getState()
                .allWorktrees()
                .some((worktree) => worktree.id === id)
            ),
          worktreeId
        ),
      { timeout: 60_000 }
    )
    .toBe(true)
  await page.evaluate((id) => {
    const state = window.__store?.getState()
    state?.setActiveView('terminal')
    state?.setActiveWorktree(id)
  }, worktreeId)
  await openPairedClientTab(page, worktreeId, webTabId)
  await new Promise((resolve) => setTimeout(resolve, 8_000))
  console.log(
    `[moved-history] import after-open ${JSON.stringify(await readClientTabState(page, webTabId))}`
  )
  return readPairedPaneContent(page, webTabId)
}

async function openImportedPane(
  testInfo: TestInfo,
  options: { importedByWslMove: boolean; historyLines?: number; reloads?: number }
): Promise<ImportedOutcome> {
  const outcome: ImportedOutcome = { marker: '', contents: [], browserUrls: [] }
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-moved-import-'))
  const repoPath = createMovedRepo(root)
  // A windowless host, as the distro's orcad is: nothing there restores a pane or a browser tab itself.
  const host = await launchHeadlessPairedRuntimeHost({ pinnedServePort: true })
  try {
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: repoPath,
      kind: 'git'
    })
    const worktreeId = `${added.result.repo.id}::${realpathSync(repoPath)}`
    outcome.marker = `imported-${randomUUID()} before the move`
    await host.restartServeProcess({
      betweenProcesses: () =>
        seedImportedMovedTab(
          host.userDataDir,
          worktreeId,
          numberedHistory(outcome.marker, options.historyLines ?? 0),
          { importedByWslMove: options.importedByWslMove }
        )
    })
    const client = await launchPairedElectronClient(host.offer, testInfo, 'moved-import')
    try {
      const webTabId = toWebTerminalSurfaceTabId(MOVED_TAB)
      outcome.contents.push(await openMovedTab(client.page, worktreeId, webTabId))
      outcome.browserUrls = await client.page.evaluate((id) => {
        const store = window.__store?.getState()
        return (store?.browserTabsByWorktree[id] ?? []).flatMap((workspace) =>
          (store?.browserPagesByWorkspace[workspace.id] ?? []).map((page) => page.url)
        )
      }, worktreeId)
      for (let reload = 0; reload < (options.reloads ?? 0); reload += 1) {
        await client.page.reload()
        await waitForSessionReady(client.page)
        outcome.contents.push(await openMovedTab(client.page, worktreeId, webTabId))
      }
      return outcome
    } finally {
      await client.dispose()
    }
  } finally {
    await host.dispose()
    rmSync(root, { recursive: true, force: true })
  }
}

function occurrences(content: string, text: string): number {
  return content.split(text).length - 1
}

test("a moved pane's stored history and browser tab show on the desktop that opens it", async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires destructuring to request no fixtures.
{}, testInfo) => {
  test.skip(process.platform === 'win32', 'POSIX paths')
  test.setTimeout(600_000)
  const outcome = await openImportedPane(testInfo, { importedByWslMove: true })
  // Exactly once: the desktop's own snapshot read must not paint it a second time over the host's.
  expect.soft(occurrences(outcome.contents[0] ?? '', outcome.marker)).toBe(1)
  expect.soft(outcome.browserUrls).toContain(MOVED_BROWSER_URL)
})

test("a moved pane's whole history shows once, through the desktop's reloads", async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires destructuring to request no fixtures.
{}, testInfo) => {
  test.skip(process.platform === 'win32', 'POSIX paths')
  test.setTimeout(600_000)
  const lines = 2_000
  const outcome = await openImportedPane(testInfo, {
    importedByWslMove: true,
    historyLines: lines,
    reloads: 2
  })
  const first = historyLine(outcome.marker, 1)
  const last = historyLine(outcome.marker, lines)
  const counts = outcome.contents.map((content) => [
    occurrences(content, first),
    occurrences(content, last)
  ])
  console.log(`[moved-history] first/last line counts per open ${JSON.stringify(counts)}`)
  for (const content of outcome.contents) {
    const numbers = [...content.matchAll(/L(\d{4}) line/g)].map((match) => Number(match[1]))
    console.log(
      `[moved-history] lines ${numbers.length} from ${numbers[0]} to ${numbers.at(-1)}; head ${JSON.stringify(content.slice(0, 300))}`
    )
  }
  // Whole (the first line survives) and once, on the first open and after each reload.
  expect(counts).toEqual(outcome.contents.map(() => [1, 1]))
})

test("an ordinary pane's saved snapshot is not replayed by a host start", async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires destructuring to request no fixtures.
{}, testInfo) => {
  test.skip(process.platform === 'win32', 'POSIX paths')
  test.setTimeout(600_000)
  // No move receipt: the same saved state on a host that was never a move's destination.
  const outcome = await openImportedPane(testInfo, { importedByWslMove: false })
  expect(outcome.contents[0]).not.toContain(outcome.marker)
})
