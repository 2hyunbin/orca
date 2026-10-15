import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import {
  createSessionCallerHarness,
  idOf,
  orchestrationRequest,
  resultOf,
  SESSION_X,
  SESSION_Y,
  WORKER_HANDLE,
  type SessionCallerHarness
} from '../../../orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../../../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const COORD_PANE = 'tab_coord:12121212-1212-4212-8212-121212121212'

describe('run-use against a Run whose coordinator is still running', () => {
  let h: SessionCallerHarness

  beforeEach(() => {
    h = createSessionCallerHarness(hostRef)
  })
  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  const as = (sessionId: string | undefined, method: string, params: Record<string, unknown>) =>
    h.dispatch(orchestrationRequest(method, params, { sessionId }))
  async function chatRun(): Promise<string> {
    return idOf(resultOf(await as(SESSION_X, 'orchestration.runCreate', { objective: 'o' })).run)
  }

  it('refuses a second chat until it passes --takeover, then fences the first', async () => {
    const runId = await chatRun()
    const before = h.db.getRunRaw(runId)

    expect(await as(SESSION_Y, 'orchestration.runUse', { id: runId })).toMatchObject({
      ok: false,
      error: { code: 'run_coordinator_live', data: { effectsApplied: false } }
    })
    expect(h.db.getRunRaw(runId)).toEqual(before)

    resultOf(await as(SESSION_Y, 'orchestration.runUse', { id: runId, takeover: true }))
    expect(await as(SESSION_X, 'orchestration.check', { run: runId })).toMatchObject({
      ok: false,
      error: { code: 'consumer_fenced' }
    })
  })

  it.each([
    ['its chat was closed', 'closed'],
    ['its terminal agent exited', 'exited'],
    ['no hook identifies its terminal agent', null]
  ] as const)('hands the Run over without a flag when %s', async (_label, state) => {
    let runId: string
    if (state === 'closed') {
      runId = await chatRun()
      hostRef.current = {
        deps: {
          store: {
            getRecord: (id: string) => h.records.get(id) ?? null,
            listRecords: () => [...h.records.values()],
            getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [SESSION_Y] })
          }
        }
      }
    } else {
      runId = h.db.createRun({
        objective: 'o',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: COORD_PANE
      }).id
      vi.spyOn(h.runtime, 'checkCoordinatorAgentPresence').mockResolvedValue(state)
    }

    resultOf(await as(SESSION_Y, 'orchestration.runUse', { id: runId }))
    expect(h.db.getRunRaw(runId)?.coordinator_orca_session_id).toBe(SESSION_Y)
  })

  it('never lets a worker take over, with or without the flag', async () => {
    const runId = await chatRun()
    const home = h.db.createRun({
      objective: 'home',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    createRootDispatch(h.db, h.db.createTask({ spec: 'w', runId: home.id }).id, WORKER_HANDLE)

    for (const takeover of [false, true]) {
      expect(
        await as(undefined, 'orchestration.runUse', { id: runId, from: WORKER_HANDLE, takeover })
      ).toMatchObject({ ok: false, error: { code: 'worker_cannot_take_over_run' } })
    }
    expect(h.db.getRunRaw(runId)?.coordinator_orca_session_id).toBe(SESSION_X)
  })
})
