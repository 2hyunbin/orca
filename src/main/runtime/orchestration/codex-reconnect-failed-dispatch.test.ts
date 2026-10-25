import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from './db'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { RuntimePtyController } from '../runtime-pty-controller-contract'

const WORKTREE_ID = 'repo-1::/tmp/codex-reconnect-failed'
const WORKER_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const WORKER_PTY_ID = 'pty-worker'
const WORKER_PANE_KEY = makePaneKey('tab-worker', WORKER_LEAF_ID)

// Codex 0.164 bytes after its app-server was killed and reconnect gave up (#24791).
const INLINE_OUTPUT =
  '\x1b[16;40r\x1b[16;1H\x1bM\x1bM\x1b[r\x1b[1;20r\x1b[15;1H\r\n\x1b[39;49m\x1b[K\x1b[38;5;1;49m' +
  '■ Automatic reconnect could not restore this session. Your draft is still editable.\x1b[39m\r\n'
// The alternate screen paints it mid-line with cursor moves; split it to straddle two chunks.
const ALT_SCREEN_CHUNKS = [
  '\x1b[33;1H\x1b[1m•\x1b[0m\x1b[17;1H\x1b[38;5;1;49m■ Automatic reconnect could',
  ' not restore this session. Your draft is still editable.\x1b[20;1H■ Server connection could not be restored'
]

function startSupervisedWorker() {
  const runtime = new OrcaRuntimeService()
  const kill = vi.fn(() => true)
  const controller: RuntimePtyController = {
    spawn: async () => ({ id: WORKER_PTY_ID }),
    write: () => true,
    kill,
    getForegroundProcess: async () => null
  }
  runtime.setPtyController(controller)
  const handle = runtime.preAllocateHandleForPty(WORKER_PTY_ID)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-worker',
        worktreeId: WORKTREE_ID,
        title: 'Worker',
        activeLeafId: WORKER_LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-worker',
        worktreeId: WORKTREE_ID,
        leafId: WORKER_LEAF_ID,
        paneRuntimeId: 1,
        ptyId: WORKER_PTY_ID,
        paneTitle: null
      }
    ]
  })
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'o',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: makePaneKey('tab-coordinator', '22222222-2222-4222-8222-222222222222')
  })
  const task = db.createTask({ spec: 'work', runId: run.id })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {}
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle,
    paneKey: WORKER_PANE_KEY,
    processIncarnation: 'inc-1',
    worktreeId: WORKTREE_ID,
    effects: [],
    setupState: 'skipped'
  })
  db.markWorkerDispatchReady(dispatch.id)
  runtime.setOrchestrationDb(db)
  return { runtime, db, kill, runId: run.id, dispatchId: dispatch.id }
}

describe('Codex reconnect failure inside a live worker PTY', () => {
  it.each([
    ['inline', [INLINE_OUTPUT]],
    ['alternate-screen', ALT_SCREEN_CHUNKS]
  ])('fails the dispatch, escalates, and leaves the %s terminal running', async (_mode, chunks) => {
    const { runtime, db, kill, runId, dispatchId } = startSupervisedWorker()
    try {
      for (const chunk of chunks) {
        runtime.onPtyData(WORKER_PTY_ID, chunk, Date.now())
      }
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect({
        dispatch: db.getDispatchContextById(dispatchId)?.status,
        worker: db.getWorkerDispatch(dispatchId)?.state,
        stage: db.getWorkerDispatch(dispatchId)?.stage,
        escalations: db
          .getUnreadRunMailbox(runId, 100, ['escalation'])
          .map((message) => message.subject)
      }).toEqual({
        dispatch: 'failed',
        worker: 'failed',
        stage: 'agent_session_lost',
        escalations: ['Agent session lost']
      })
      expect(kill).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it('ignores the sentence when it is quoted output rather than Codex error cell', () => {
    const { runtime, db, dispatchId } = startSupervisedWorker()
    try {
      runtime.onPtyData(
        WORKER_PTY_ID,
        'tui/src/chatwidget/reconnect.rs:259: "Automatic reconnect could not restore this session."\r\n',
        Date.now()
      )
      expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
    } finally {
      db.close()
    }
  })
})
