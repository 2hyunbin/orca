import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { structuredAgentSessionEndedChildFailure } from './structured-agent-session-ended-child-failure'
import {
  createRestTestRig,
  foundRestTestChat,
  REST_TEST_CALLER as CALLER,
  REST_TEST_SESSION as SESSION,
  restTestSend,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type {
  StructuredAgentSessionChildEndCause,
  StructuredAgentSessionEndedChild
} from './structured-agent-session-host-types'

const EXIT_FAILURE = agentSessionFailureFact('providerExited', {
  detail: { text: 'crashed', audience: 'log' }
})

function ended(
  cause: StructuredAgentSessionChildEndCause,
  duringStartup: boolean
): StructuredAgentSessionEndedChild {
  return {
    generation: 'generation-1',
    fence: 2,
    rootGone: true,
    cause,
    reason: null,
    failure: EXIT_FAILURE,
    duringStartup,
    endedAt: { epoch: 'epoch-1', sequence: 3 }
  }
}

describe('what a child end means for the messages queued behind it', () => {
  it.each([false, true])("fails nothing after a user's Stop (during startup: %s)", (starting) => {
    expect(structuredAgentSessionEndedChildFailure(ended('user-stop', starting))).toBeNull()
  })

  it.each([false, true])(
    'keeps a recorded failure after a host stop (during startup: %s)',
    (starting) => {
      expect(structuredAgentSessionEndedChildFailure(ended('host-stop', starting))).toEqual({
        failure: EXIT_FAILURE
      })
      expect(
        structuredAgentSessionEndedChildFailure({
          ...ended('host-stop', starting),
          failure: undefined
        })
      ).toEqual({
        failure: { kind: 'hostStopped' }
      })
    }
  )

  it.each(['exit', 'attach-failed', 'evict'] as const)(
    'carries the recorded failure of a %s, as a failed start while starting',
    (cause) => {
      expect(structuredAgentSessionEndedChildFailure(ended(cause, true))).toEqual({
        exit: EXIT_FAILURE
      })
      expect(structuredAgentSessionEndedChildFailure(ended(cause, false))).toEqual({
        failure: EXIT_FAILURE
      })
      expect(
        structuredAgentSessionEndedChildFailure({ ...ended(cause, false), failure: undefined })
      ).toEqual({ failure: agentSessionFailureFact('providerExited') })
    }
  )
})

describe('a send behind a turn the journal says is running but the agent is not', () => {
  let rig: RestTestRig

  beforeEach(async () => {
    rig = await createRestTestRig()
  })

  afterEach(async () => {
    await rig.dispose()
  })

  const fence = () => rig.store.getRecord(SESSION)?.lease.runtimeFence ?? 1
  const loop = () => rig.host.collaboratorsForTests().conversationDelivery.loop
  const timerFires = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  it('is handed over once and delivery parks, with the main thread free', async () => {
    await foundRestTestChat(rig)
    const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
    // The shape history catch-up left after an update: an earlier prompt's turn, running under the live child.
    await journal.appendItem(
      { provider: 'claude', sessionId: 'provider-session', uuid: 'imported-turn' },
      { kind: 'turn', turnId: 'imported-turn', state: 'running', startedAt: 1 },
      { fence: fence(), turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    expect((await rig.host.send(CALLER, restTestSend('after the update', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(loop().isRunning(SESSION)).toBe(false))
    await timerFires()
    expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2)
    const sent = journal.submissions().filter((row) => row.dispatchState === 'accepted')
    expect(sent).toHaveLength(2)
  })

  it('parks a step that changed nothing instead of retrying it', async () => {
    await foundRestTestChat(rig)
    const deps = loop()['deps']
    // A start that settles while its flight still reads as running leaves every fact as it was.
    vi.spyOn(deps.startFlights!, 'has').mockReturnValue(true)
    const start = vi
      .spyOn(deps, 'startProviderChild')
      .mockImplementation(() => ({ outcome: Promise.resolve({ ok: true as const }) }))
    expect((await rig.host.send(CALLER, restTestSend('no progress', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(start).toHaveBeenCalled())
    await vi.waitFor(() => expect(loop().isRunning(SESSION)).toBe(false))
    await timerFires()
    expect(start.mock.calls.length).toBeLessThanOrEqual(3)
    expect(rig.adapter.dispatch).toHaveBeenCalledTimes(1)
  })
})
