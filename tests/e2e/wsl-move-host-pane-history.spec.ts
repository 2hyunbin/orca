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
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
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
import { createRestartSession } from './helpers/orca-restart'
import { mutateStoppedProfileState } from './helpers/persisted-profile-state'
import { waitForSessionReady } from './helpers/store'
import { quotePosixShell } from '../../src/shared/shell-argument-quoting'
import { makeTerminalScrollbackSnapshotRef } from '../../src/main/terminal-scrollback-snapshots'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'
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

const MOVED_TAB = 'moved-tab-0001'
const MOVED_LEAF = 'moved-leaf-0001'
const MOVED_GROUP = 'moved-group-0001'

/**
 * The host's state right after it imported a moved project: a terminal tab whose only history is
 * a stored scrollback snapshot, with no terminal session behind it (the move strips the desktop's).
 */
function seedImportedMovedTab(userDataDir: string, worktreeId: string, history: string): void {
  const ref = makeTerminalScrollbackSnapshotRef(MOVED_TAB, MOVED_LEAF)
  const roots = [userDataDir, path.join(userDataDir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID)]
  for (const root of roots) {
    mkdirSync(path.join(root, 'terminal-scrollback'), { recursive: true })
    writeFileSync(path.join(root, 'terminal-scrollback', `${ref}.bin`), history)
  }
  mutateStoppedProfileState(userDataDir, (state) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this test seeded the profile and reads only these session maps.
    const session = state.workspaceSession as Record<string, Record<string, unknown>>
    // Why: a headless host has no window that would restore the pane itself; keep the fixture's off it.
    Reflect.set(session, 'activeWorktreeId', null)
    session.tabsByWorktree = {
      ...session.tabsByWorktree,
      [worktreeId]: [
        {
          id: MOVED_TAB,
          ptyId: null,
          worktreeId,
          title: 'Shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    }
    session.unifiedTabs = {
      ...session.unifiedTabs,
      [worktreeId]: [
        {
          id: MOVED_TAB,
          entityId: MOVED_TAB,
          groupId: MOVED_GROUP,
          worktreeId,
          contentType: 'terminal',
          label: 'Shell',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    }
    session.tabGroups = {
      ...session.tabGroups,
      [worktreeId]: [{ id: MOVED_GROUP, worktreeId, activeTabId: MOVED_TAB, tabOrder: [MOVED_TAB] }]
    }
    session.activeGroupIdByWorktree = {
      ...session.activeGroupIdByWorktree,
      [worktreeId]: MOVED_GROUP
    }
    session.terminalLayoutsByTabId = {
      ...session.terminalLayoutsByTabId,
      [MOVED_TAB]: {
        root: { type: 'leaf', leafId: MOVED_LEAF },
        activeLeafId: MOVED_LEAF,
        expandedLeafId: null,
        scrollbackRefsByLeafId: { [MOVED_LEAF]: ref }
      }
    }
  })
}

function createRepo(root: string): string {
  const repoPath = path.join(root, 'moved-repo')
  mkdirSync(repoPath)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath })
  const identity = ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid']
  execFileSync('git', [...identity, 'commit', '-q', '--allow-empty', '-m', 'init'], {
    cwd: repoPath
  })
  return repoPath
}

test("an imported moved pane's stored history shows on the desktop that opens it", async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires destructuring to request no fixtures.
{}, testInfo) => {
  test.skip(process.platform === 'win32', 'POSIX paths')
  test.setTimeout(600_000)
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-moved-import-'))
  const repoPath = createRepo(root)
  const host = createRestartSession(testInfo)
  let launched: Awaited<ReturnType<typeof host.launch>> | undefined
  try {
    launched = await host.launch()
    await waitForSessionReady(launched.page)
    const repoId = await launched.page.evaluate(async (repo) => {
      const result = await window.api.repos.add({ path: repo })
      if ('error' in result) {
        throw new Error(result.error)
      }
      return result.repo.id
    }, repoPath)
    const worktreeId = `${repoId}::${realpathSync(repoPath)}`
    await host.close(launched.app)
    launched = undefined

    const marker = `imported-${randomUUID()}`
    seedImportedMovedTab(host.userDataDir, worktreeId, `${marker} before the move\r\n`)
    launched = await host.launch()
    await waitForSessionReady(launched.page)
    const offer = await createRuntimeDesktopPairingOffer(launched.page)
    const client = await launchPairedElectronClient(offer, testInfo, 'moved-import')
    try {
      const webTabId = toWebTerminalSurfaceTabId(MOVED_TAB)
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
      await client.page.evaluate((id) => {
        const state = window.__store?.getState()
        state?.setActiveView('terminal')
        state?.setActiveWorktree(id)
      }, worktreeId)
      console.log(
        `[moved-history] import client-tabs ${JSON.stringify(
          await client.page.evaluate(
            (id) => ({
              terminals: (window.__store?.getState().tabsByWorktree[id] ?? []).map((t) => t.id),
              unified: (window.__store?.getState().unifiedTabsByWorktree[id] ?? []).map((t) => t.id)
            }),
            worktreeId
          )
        )}`
      )
      await openPairedClientTab(client.page, worktreeId, webTabId)
      await new Promise((resolve) => setTimeout(resolve, 8_000))
      const state = await readClientTabState(client.page, webTabId)
      console.log(`[moved-history] import after-open ${JSON.stringify(state)}`)
      const content = await readPairedPaneContent(client.page, webTabId)
      console.log(`[moved-history] import content-tail ${JSON.stringify(content.slice(-300))}`)
      expect(content).toContain(`${marker} before the move`)
    } finally {
      await client.dispose()
    }
  } finally {
    if (launched) {
      await host.close(launched.app)
    }
    await host.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
