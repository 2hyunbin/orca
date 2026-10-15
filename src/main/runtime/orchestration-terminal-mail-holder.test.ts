import './rpc/unused-default-rpc-methods.test-fixture'
// A terminal coordinator's fetched batch is held by its pane's process and the turn its hooks
// report: offered once more only when that turn was cut, never re-fed after a normal end.
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { AgentEndedOpenTurn } from '../agent-hooks/server/server-ended-open-turns'
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
function hookRow(
  conversation: string,
  turnStartedAt: number | undefined,
  state: 'working' | 'done' = 'done'
): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    agentType: 'codex',
    state,
    prompt: '',
    connectionId: null,
    launchToken: LAUNCH_TOKEN,
    providerSession: { key: 'session_id', id: conversation },
    receivedAt: Date.now(),
    stateStartedAt: Date.now(),
    ...(turnStartedAt === undefined ? {} : { turnStartedAt }),
    mainAgent:
      state === 'done'
        ? { state, outcome: 'success', stateStartedAt: Date.now() }
        : { state, stateStartedAt: Date.now() }
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

  it('offers again what a turn held when its agent died mid-turn and was resumed in the shell', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-terminal-mail-resume-')
    const rows = [hookRow('conversation-1', undefined)]
    let ended: AgentEndedOpenTurn | null = null
    const { runtime, write } = createRuntime(db, {
      getAgentStatusSnapshot: () => rows,
      getEndedOpenAgentTurnForPane: () => ended
    })
    const run = createBoundRun(db, 'Terminal resume Run')
    db.insertMessage({ from: 'term_worker', to: `run:${run.id}`, subject: 'Final', runId: run.id })
    await driveToLiveIdle(runtime)
    await vi.advanceTimersByTimeAsync(500)
    expect(pointerCount(write)).toBe(1)

    // The notice opened a turn, and the agent process ended in it before it ran `check`; `--resume`
    // brings the same conversation back to its prompt. The notice is typed once more.
    const noticeTurn = Date.now()
    ended = { conversationId: 'conversation-1', turnStartedAt: noticeTurn }
    rows.splice(0, 1, hookRow('conversation-1', noticeTurn))
    await driveToLiveIdle(runtime)
    await vi.advanceTimersByTimeAsync(500)
    expect(pointerCount(write)).toBe(2)

    // The resumed agent's next turn fetched the mail and died the same way: its batch is let go,
    // and the mail, offered once already after a cut, waits for the next `check` to replay it.
    const checkTurn = Date.now()
    rows.splice(0, 1, hookRow('conversation-1', checkTurn, 'working'))
    const batch = await checkBoundMailbox(runtime)
    ended = { conversationId: 'conversation-1', turnStartedAt: checkTurn }
    rows.splice(0, 1, hookRow('conversation-1', checkTurn))
    await driveToLiveIdle(runtime)
    await vi.advanceTimersByTimeAsync(500)
    expect(pointerCount(write)).toBe(2)
    expect(db.getDeliveryRaw(batch.deliveryId ?? '')?.holder).toBeNull()
    expect(await checkBoundMailbox(runtime)).toMatchObject({
      deliveryId: batch.deliveryId,
      replayed: true
    })
    db.close()
  })
})
