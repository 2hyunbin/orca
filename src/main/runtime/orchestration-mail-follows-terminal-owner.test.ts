import './rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { settledWriteStub } from '../providers/settled-pty-write-stub'
import {
  createRuntime,
  LEAF_ID,
  PANE_KEY,
  pointerCount,
  PTY_ID,
  SECOND_LEAF_ID,
  SECOND_TAB_ID,
  TAB_ID,
  WORKTREE_ID
} from './orchestration-mailbox-notification-test-harness'

const RENDERER_PTY_ID = 'pty-renderer'
const GRAPH = {
  tabs: [
    { tabId: TAB_ID, worktreeId: WORKTREE_ID, title: 'Codex', activeLeafId: LEAF_ID, layout: null }
  ],
  leaves: [
    {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      worktreeId: WORKTREE_ID,
      paneRuntimeId: 1,
      ptyId: RENDERER_PTY_ID
    }
  ]
}

describe('Run mail follows the terminal that owns its mailbox', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not type a stale pointer after the terminal moves to another pane mid-probe', async () => {
    const db = new OrchestrationDb(':memory:')
    const { runtime } = createRuntime(db)
    const write = vi.fn(() => true)
    let finishProbe: ((live: boolean) => void) | undefined
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: () => true,
      getForegroundProcess: async () => null,
      probePtyLiveness: () => new Promise<boolean>((resolve) => (finishProbe = resolve))
    })
    const [terminal] = (await runtime.listTerminals()).terminals
    const run = db.createRun({
      objective: 'Moved coordinator',
      coordinatorHandle: terminal.handle,
      coordinatorPaneKey: PANE_KEY
    })
    runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 1)
    await runtime.serializeMainTerminalBuffer(PTY_ID)
    db.insertMessage({
      from: 'term_sender',
      to: `run:${run.id}`,
      subject: 'old pane',
      type: 'status',
      runId: run.id
    })
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(0)
    expect(finishProbe).toBeTypeOf('function')

    runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: SECOND_TAB_ID,
      leafId: SECOND_LEAF_ID,
      incarnationId: 'mailbox-incarnation'
    })
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: SECOND_TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Moved',
          activeLeafId: SECOND_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: SECOND_TAB_ID,
          leafId: SECOND_LEAF_ID,
          worktreeId: WORKTREE_ID,
          ptyId: PTY_ID,
          paneRuntimeId: 2
        }
      ]
    })
    finishProbe?.(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(pointerCount(write)).toBe(0)
    db.close()
  })

  it('points Run mail at a pane-issued handle while the renderer reloads', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService(null)
    const write = vi.fn(() => true)
    runtime.setOrchestrationDb(db)
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.registerPty(RENDERER_PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: 'original'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, GRAPH)
    const [terminal] = (await runtime.listTerminals()).terminals
    const run = db.createRun({
      objective: 'Reloading coordinator',
      coordinatorHandle: terminal.handle,
      coordinatorPaneKey: `${TAB_ID}:${LEAF_ID}`
    })
    runtime.onPtyData(RENDERER_PTY_ID, '\x1b]0;Codex done\x07', 1)
    await runtime.serializeMainTerminalBuffer(RENDERER_PTY_ID)
    runtime.markRendererReloading(1)
    db.insertMessage({
      from: 'term_sender',
      to: `run:${run.id}`,
      subject: 'new mail',
      type: 'status',
      runId: run.id
    })
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(0)
    expect(pointerCount(write)).toBe(1)
    db.close()
  })
})
