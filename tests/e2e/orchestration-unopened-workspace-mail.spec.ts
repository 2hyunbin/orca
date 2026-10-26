// STA-11630, #24354: orchestration addresses a terminal, not the pane a window shows for it.
// A worker whose workspace was never opened has no pane; its mail and waits must still work.
import { readFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import {
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { RuntimeClient } from '../../src/cli/runtime-client'
import type {
  RuntimeTerminalCreate,
  RuntimeTerminalListResult,
  RuntimeTerminalSummary,
  RuntimeTerminalWait
} from '../../src/shared/runtime-types'
import {
  CODEX_IDLE_TITLE,
  CODEX_WORKING_TITLE,
  createMailPaneAgent,
  type MailPaneAgent
} from './helpers/orchestration-mail-pane-agent'
import { mailDisposition, readMailRow } from './helpers/orchestration-mail-store'

const POINTER_COMMAND = 'orca-dev orchestration check'
const DELIVERY_TIMEOUT_MS = 20_000

type BackgroundWorker = {
  client: RuntimeClient
  userDataDir: string
  worktreeId: string
  handle: string
  agent: MailPaneAgent
}

async function startWorkerInUnopenedWorkspace(
  page: Page,
  electronApp: ElectronApplication
): Promise<BackgroundWorker> {
  await waitForSessionReady(page)
  const activeWorktreeId = await waitForActiveWorktree(page)
  const worktreeId = (await getAllWorktreeIds(page)).find((id) => id !== activeWorktreeId)
  if (!worktreeId) {
    throw new Error('needs the seeded secondary worktree')
  }
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const client = new RuntimeClient(userDataDir, 30_000, null, null)
  await expect
    .poll(
      async () => {
        const listed = await client.call<{ worktrees: { id: string }[] }>('worktree.list', {})
        return listed.result.worktrees.some((worktree) => worktree.id === worktreeId)
      },
      { timeout: 60_000, message: 'runtime never registered the secondary worktree' }
    )
    .toBe(true)

  const agent = createMailPaneAgent()
  const created = await client.call<{ terminal: RuntimeTerminalCreate }>('terminal.create', {
    worktree: `id:${worktreeId}`,
    command: agent.launchCommand
  })
  const handle = created.result.terminal.handle
  await expect
    .poll(() => agent.hasStarted(), { timeout: 60_000, message: 'agent never started' })
    .toBe(true)
  return { client, userDataDir, worktreeId, handle, agent }
}

async function findUnopenedWorktree(
  page: Page,
  client: RuntimeClient,
  activeWorktreeId: string
): Promise<string> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const state = window.__store!.getState()
          await state.fetchWorktrees(state.repos[0]!.id)
          return window.__store!.getState().allWorktrees().length
        }),
      { timeout: 60_000 }
    )
    .toBeGreaterThan(1)
  const worktreeId = await page.evaluate(
    (activeId) =>
      window
        .__store!.getState()
        .allWorktrees()
        .find((worktree) => worktree.id !== activeId)!.id,
    activeWorktreeId
  )
  await expect
    .poll(
      () =>
        client.call('worktree.show', { worktree: `id:${worktreeId}` }).then(
          () => true,
          () => false
        ),
      { timeout: 120_000 }
    )
    .toBe(true)
  return worktreeId
}

async function readSummary(worker: BackgroundWorker): Promise<RuntimeTerminalSummary | undefined> {
  const listed = await worker.client.call<RuntimeTerminalListResult>('terminal.list')
  return listed.result.terminals.find((entry) => entry.handle === worker.handle)
}

async function waitForObservedTitle(worker: BackgroundWorker, title: string): Promise<void> {
  await expect
    .poll(async () => (await readSummary(worker))?.title ?? null, {
      timeout: 30_000,
      message: `runtime never observed the title ${title}`
    })
    .toBe(title)
}

test.describe('orchestration for a worker whose workspace is not open', () => {
  // oxlint-disable-next-line no-empty-pattern -- Owns both app launches; Playwright needs the fixtures argument.
  test('points a worker that survived a restart at its mail on its idle edge', async ({}, testInfo) => {
    // Two full app launches with a quit between them.
    test.setTimeout(300_000)
    const session = createRestartSession(testInfo)
    const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    let { app } = await session.launch()
    try {
      const page = await app.firstWindow()
      const active = await attachRepoAndOpenTerminal(page, repoPath)
      await waitForSessionReady(page)
      const client = new RuntimeClient(session.userDataDir, 30_000, null, null)
      const unopened = await findUnopenedWorktree(page, client, active)
      const agent = createMailPaneAgent()
      const created = await client.call<{ terminal: RuntimeTerminalCreate }>('terminal.create', {
        worktree: `id:${unopened}`,
        command: agent.launchCommand,
        focus: false,
        activate: false,
        presentation: 'background'
      })
      const { ptyId } = created.result.terminal
      await expect.poll(() => agent.hasStarted(), { timeout: 60_000 }).toBe(true)

      await session.close(app)
      const second = await session.launch()
      app = second.app
      await waitForSessionReady(second.page)
      await waitForActiveWorktree(second.page)
      const survivor = async (): Promise<RuntimeTerminalSummary | undefined> =>
        (await client.call<RuntimeTerminalListResult>('terminal.list')).result.terminals.find(
          (terminal) => terminal.ptyId === ptyId
        )
      // STA-11630's precondition: a live terminal no window pane shows.
      await expect.poll(async () => (await survivor())?.orphaned, { timeout: 60_000 }).toBe(true)
      const handle = (await survivor())!.handle
      const worker = {
        client,
        userDataDir: session.userDataDir,
        worktreeId: unopened,
        handle,
        agent
      }

      agent.setTitle(CODEX_WORKING_TITLE)
      await waitForObservedTitle(worker, CODEX_WORKING_TITLE)
      const run = await client.call<{ run: { id: string } }>('orchestration.runCreate', {
        objective: 'Unopened workspace mail',
        from: handle
      })
      const sent = await client.call<{ message: { id: string } }>('orchestration.send', {
        to: `run:${run.result.run.id}`,
        from: 'e2e-sender',
        subject: 'Unopened workspace mail',
        body: 'e2e body',
        type: 'status'
      })

      agent.setTitle(CODEX_IDLE_TITLE)
      await expect
        .poll(() => agent.readStdin(), {
          timeout: DELIVERY_TIMEOUT_MS,
          message: 'mail pointer never reached the worker'
        })
        .toContain(POINTER_COMMAND)
      await expect
        .poll(() => agent.readStdin().includes('\r'), { timeout: DELIVERY_TIMEOUT_MS })
        .toBe(true)
      await expect
        .poll(() => mailDisposition(readMailRow(session.userDataDir, sent.result.message.id)), {
          timeout: DELIVERY_TIMEOUT_MS
        })
        .toBe('pushed')
    } finally {
      await session.dispose(app).catch(() => undefined)
    }
  })

  test('a wait survives opening the worker workspace mid-wait', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(180_000)
    const worker = await startWorkerInUnopenedWorkspace(orcaPage, electronApp)
    worker.agent.setTitle(CODEX_WORKING_TITLE)
    await waitForObservedTitle(worker, CODEX_WORKING_TITLE)

    const wait = worker.client.call<{ wait: RuntimeTerminalWait }>(
      'terminal.wait',
      { terminal: worker.handle, for: 'tui-idle', timeoutMs: 60_000 },
      { timeoutMs: 90_000 }
    )
    const settled = wait.then(
      (response) => ({ ok: true as const, wait: response.result.wait }),
      (error: unknown) => ({ ok: false as const, error: String(error) })
    )

    // Opening the workspace mounts a pane for the worker's live terminal.
    await switchToWorktree(orcaPage, worker.worktreeId)
    await expect
      .poll(async () => (await readSummary(worker))?.orphaned, {
        timeout: 30_000,
        message: 'the opened workspace never showed the worker terminal in a pane'
      })
      .toBe(false)

    worker.agent.setTitle(CODEX_IDLE_TITLE)
    const outcome = await settled
    expect(outcome).toMatchObject({ ok: true, wait: { handle: worker.handle, satisfied: true } })
    // The worker keeps its name: the pane that now shows it does not mint a new handle.
    expect(await readSummary(worker)).toMatchObject({ orphaned: false, connected: true })
  })
})
