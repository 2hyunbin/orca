import './rpc/unused-default-rpc-methods.test-fixture'
// A terminal coordinator's fetched batch is held by its pane's process and the turn its hooks
// report: offered once more only when that turn was cut, never re-fed after a normal end.
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { OrchestrationDb } from './orchestration/db'
import {
  checkBoundMailbox,
  createBoundRun,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  LAUNCH_TOKEN,
  PANE_KEY,
  pointerCount,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

/** The hook server's row for the pane: one agent conversation and the turn it is on. */
function hookRow(conversation: string, turnStartedAt: number | undefined): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    agentType: 'codex',
    state: 'done',
    prompt: '',
    connectionId: null,
    launchToken: LAUNCH_TOKEN,
    providerSession: { key: 'session_id', id: conversation },
    receivedAt: Date.now(),
    stateStartedAt: Date.now(),
    ...(turnStartedAt === undefined ? {} : { turnStartedAt }),
    mainAgent: { state: 'done', outcome: 'success', stateStartedAt: Date.now() }
  }
}

describe('a terminal coordinator holding a fetched batch', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('gets it again when its shell was replaced across a restart, not after a /clear', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-terminal-mail-holder-')
    const rows = [hookRow('conversation-1', 100)]
    const first = createRuntime(db, { getAgentStatusSnapshot: () => rows })
    const run = createBoundRun(db, 'Terminal holder Run')
    db.insertMessage({ from: 'term_worker', to: `run:${run.id}`, subject: 'Final', runId: run.id })
    await driveToLiveIdle(first.runtime)
    await vi.advanceTimersByTimeAsync(500)
    expect(pointerCount(first.write)).toBe(1)
    const batch = await checkBoundMailbox(first.runtime)
    expect(batch.count).toBe(1)

    // The turn ended normally; `/clear` then opened a fresh conversation in the same shell. The
    // batch was handled, so nothing feeds it to the fresh conversation.
    rows.splice(0, 1, hookRow('conversation-2', undefined))
    await driveToLiveIdle(first.runtime)
    await vi.advanceTimersByTimeAsync(500)
    expect(pointerCount(first.write)).toBe(1)

    // Orca restarts and the pane's shell did not survive it: a new process under a new handle,
    // while the Run still names the old one. The pane's batch is offered there once more.
    first.runtime.setOrchestrationDb(new OrchestrationDb(':memory:'))
    const second = createRuntime(db, {
      getAgentStatusSnapshot: () => rows,
      incarnationId: 'mailbox-incarnation-after-restart',
      handle: 'term_after_restart'
    })
    await driveToLiveIdle(second.runtime)
    await vi.advanceTimersByTimeAsync(500)
    expect(pointerCount(second.write)).toBe(1)
    expect(
      await checkBoundMailbox(second.runtime, { terminal: 'term_after_restart' })
    ).toMatchObject({ deliveryId: batch.deliveryId, replayed: true })
    db.close()
  })
})
