import './rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './orchestration/db'
import {
  createRuntime,
  PANE_KEY,
  pointerCount,
  PTY_ID
} from './orchestration-mailbox-notification-test-harness'

// A headless server publishes no renderer leaves, so its terminals live only in the PTY lane.
async function headlessCoordinator() {
  const db = new OrchestrationDb(':memory:')
  const { runtime, write } = createRuntime(db)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  const [terminal] = (await runtime.listTerminals()).terminals
  const run = db.createRun({
    objective: 'Headless Run',
    coordinatorHandle: terminal.handle,
    coordinatorPaneKey: PANE_KEY
  })
  const sendRunMail = () => {
    const message = db.insertMessage({
      from: 'term_worker',
      to: `run:${run.id}`,
      subject: 'Worker complete',
      type: 'worker_done',
      runId: run.id
    })
    runtime.notifyMessageArrived(`run:${run.id}`, 'worker_done')
    return message
  }
  return { db, runtime, write, sendRunMail }
}

describe('headless orchestration mailbox pointer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('points an already idle coordinator at Run mail', async () => {
    const { db, runtime, write, sendRunMail } = await headlessCoordinator()
    runtime.onPtyData(PTY_ID, '\x1b]0;Codex working\x07', 1)
    runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 2)
    await runtime.serializeMainTerminalBuffer(PTY_ID)

    const message = sendRunMail()
    await vi.advanceTimersByTimeAsync(0)
    expect(pointerCount(write)).toBe(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(write).toHaveBeenCalledWith(PTY_ID, '\r')
    expect(db.getMessageById(message.id)?.delivered_at).toEqual(expect.any(String))
    db.close()
  })

  it('points a coordinator at mail that arrived while it worked once it goes idle', async () => {
    const { db, runtime, write, sendRunMail } = await headlessCoordinator()
    runtime.onPtyData(PTY_ID, '\x1b]0;Codex working\x07', 1)
    await runtime.serializeMainTerminalBuffer(PTY_ID)
    const message = sendRunMail()
    await vi.advanceTimersByTimeAsync(0)
    expect(pointerCount(write)).toBe(0)

    runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 2)
    await runtime.serializeMainTerminalBuffer(PTY_ID)
    await vi.advanceTimersByTimeAsync(0)
    expect(pointerCount(write)).toBe(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(db.getMessageById(message.id)?.delivered_at).toEqual(expect.any(String))
    db.close()
  })

  it('waits for a name-only idle pane to go quiet before typing the pointer', async () => {
    const { db, runtime, write, sendRunMail } = await headlessCoordinator()
    sendRunMail()
    runtime.onPtyData(PTY_ID, '\x1b]0;⠋ Codex\x07working\n', Date.now())
    runtime.onPtyData(PTY_ID, '\x1b]0;Codex\x07still working\n', Date.now())
    await runtime.serializeMainTerminalBuffer(PTY_ID)
    expect(pointerCount(write)).toBe(0)

    await vi.advanceTimersByTimeAsync(3_050)
    expect(pointerCount(write)).toBe(1)
    db.close()
  })
})
