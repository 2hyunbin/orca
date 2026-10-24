import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import { StructuredAgentSessionStatusOwnership } from '../native-chat/agent-session-wire/structured-agent-session-status-ownership'
import type { StructuredAgentSessionChildWorkProducer } from '../native-chat/agent-session-wire/structured-agent-session-subagent-rows'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  refusingSink,
  type ProviderTimelineRig
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { AcpStructuredLane } from './acp-structured-lane'
import type { AcpTimelineEvent } from './acp-timeline-event'
import { GROK_ACP_DIALECT } from './acp-dialects/grok-dialect'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { providerTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import {
  recordingStructuredAgentSessionLogger,
  testEventSinkLogging
} from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'

const lanes: AcpStructuredLane[] = []
afterEach(async () => {
  await Promise.all(
    lanes.splice(0).map(async (lane) => {
      lane.dispose()
      await lane.written()
    })
  )
  vi.restoreAllMocks()
  await closeProviderTimelineRigs()
})

/** What Grok says about one subagent, translated as the adapter would. */
function subagent(
  lane: AcpStructuredLane,
  state: 'working' | 'completed',
  description = 'Exact label'
): AcpTimelineEvent[] {
  const update =
    state === 'working'
      ? { sessionUpdate: 'subagent_spawned', subagent_id: 'child', description }
      : { sessionUpdate: 'subagent_finished', subagent_id: 'child', status: 'completed' }
  return lane.translator.notification(
    '_x.ai/session/update',
    { sessionId: 'provider-session-1', update },
    1
  )
}

function committedEvidence(
  rig: ProviderTimelineRig,
  producer: StructuredAgentSessionChildWorkProducer,
  published: (evidence: AgentChildWorkEvidence[]) => void,
  owner = new StructuredAgentSessionStatusOwnership(() => undefined)
) {
  return (evidence: AgentChildWorkEvidence[]) =>
    owner.publishChildWork(
      'session-timeline',
      evidence,
      'grok',
      producer,
      {
        journal: rig.journal,
        scope: () => AGENT_JOURNAL_THREAD_SCOPE
      },
      () => published(evidence)
    )
}

async function fixture(reason: 'backpressure' | 'failed' = 'backpressure') {
  const rig = await openProviderTimelineRig()
  const delivery: AgentChildWorkEvidence[][] = []
  const refused = { value: false }
  const failed = vi.fn()
  const owner = new StructuredAgentSessionStatusOwnership(() => undefined)
  const sink = refusingSink(rig.sink, () => refused.value, reason)
  const lane = new AcpStructuredLane({
    sink,
    sessionId: 'session-timeline',
    providerSessionId: 'provider-session-1',
    agent: 'grok',
    agentName: 'Grok',
    generation: 'gen-1',
    dialect: GROK_ACP_DIALECT,
    logger: recordingStructuredAgentSessionLogger().logger,
    onInputAccepted: () => {},
    onFailed: failed,
    onChildWorkEvidence: committedEvidence(
      rig,
      { ...rig.eventSink, ...sink },
      (evidence) => delivery.push(evidence),
      owner
    ),
    now: () => 10
  })
  lanes.push(lane)
  return { rig, lane, refused, delivery, failed, owner }
}

describe('ACP subagent evidence at the ordered journal boundary', () => {
  it('delivers acquisition-time snapshots only after the journal binds and publishes the parent', async () => {
    const rig = await openProviderTimelineRig()
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    const sink = providerTimelineSink(deferred.sink)
    if (!sink) {
      throw new Error('Missing transition sink')
    }
    let parentPublished = false
    const delivered = vi.fn(() => parentPublished)
    const lane = new AcpStructuredLane({
      sink,
      sessionId: 'session-timeline',
      providerSessionId: 'provider-session-1',
      agent: 'grok',
      agentName: 'Grok',
      generation: 'gen-1',
      dialect: GROK_ACP_DIALECT,
      logger: recordingStructuredAgentSessionLogger().logger,
      onInputAccepted: () => {},
      onFailed: () => {},
      onChildWorkEvidence: committedEvidence(rig, deferred.sink, delivered)
    })
    lanes.push(lane)
    lane.apply(
      lane.translator.notification(
        '_x.ai/session/update',
        {
          sessionId: 'provider-session-1',
          update: {
            sessionUpdate: 'subagent_spawned',
            subagent_id: 'child',
            description: 'Exact label'
          }
        },
        1
      )
    )
    lane.apply(
      lane.translator.notification(
        '_x.ai/session/update',
        {
          sessionId: 'provider-session-1',
          update: { sessionUpdate: 'subagent_finished', subagent_id: 'child', status: 'completed' }
        },
        2
      )
    )
    expect(delivered).not.toHaveBeenCalled()
    deferred.bind({
      journal: rig.journal,
      fence: 1,
      publish: () => {
        parentPublished = true
      }
    })
    expect(await deferred.drained()).toEqual({ ok: true })
    expect(await lane.written()).toEqual({ ok: true })
    expect(delivered).toHaveBeenCalledTimes(2)
    expect(delivered.mock.results.map(({ value }) => value)).toEqual([true, true])
    deferred.close()
  })
  it('holds working and finished snapshots in order across backpressure and publishes each once', async () => {
    const { rig, lane, refused, delivery } = await fixture()
    refused.value = true
    lane.apply(subagent(lane, 'working'))
    lane.apply(subagent(lane, 'working', 'Updated label'))
    lane.apply(subagent(lane, 'completed'))
    await rig.rows()
    expect(delivery).toEqual([])
    refused.value = false
    lane.retry()
    await rig.rows()
    expect(delivery.map((batch) => batch.map((edge) => edge.type))).toEqual([
      ['live'],
      ['live'],
      ['ended']
    ])
    expect(delivery[0][0]).toMatchObject({ child: { kind: 'agent', description: 'Exact label' } })
    expect(delivery[1][0]).toMatchObject({ child: { kind: 'agent', description: 'Updated label' } })
    expect(delivery[2][0]).toMatchObject({ outcome: 'succeeded' })
    expect(await lane.written()).toEqual({ ok: true })
    lane.retry()
    await rig.rows()
    expect(delivery).toHaveLength(3)
  })

  it('publishes no subagent facts for fatal refusal, disposed held events or events dropped after session end', async () => {
    const fatal = await fixture('failed')
    fatal.refused.value = true
    fatal.lane.apply(subagent(fatal.lane, 'working'))
    await expect(fatal.lane.written()).resolves.toMatchObject({ ok: false })
    await fatal.rig.rows()
    expect(fatal.failed).toHaveBeenCalledWith('failed')
    expect(fatal.delivery).toEqual([])
    const held = await fixture()
    held.refused.value = true
    held.lane.apply(subagent(held.lane, 'working'))
    held.lane.dispose()
    await expect(held.lane.written()).resolves.toMatchObject({ ok: false })
    expect(held.owner.childWorkOpen('session-timeline')).toBe(false)
    held.refused.value = false
    held.lane.retry()
    await held.rig.rows()
    expect(held.delivery).toEqual([])
    const ended = await fixture()
    ended.lane.apply([
      { type: 'session.ended', verdict: { state: 'interrupted', completedAt: 10 } }
    ])
    await ended.rig.rows()
    ended.lane.apply(subagent(ended.lane, 'working'))
    await ended.rig.rows()
    expect(ended.delivery.flat().map((edge) => edge.type)).toEqual(['session-ended'])
  })

  it('does not let a throwing optional evidence consumer poison the journal', async () => {
    const { rig, lane } = await fixture()
    const failure = vi.fn()
    const reports = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const throwing = new AcpStructuredLane({
      sink: rig.sink,
      sessionId: 'session-timeline',
      providerSessionId: 'provider-session-1',
      agent: 'grok',
      agentName: 'Grok',
      generation: 'gen-2',
      dialect: GROK_ACP_DIALECT,
      logger: recordingStructuredAgentSessionLogger().logger,
      onInputAccepted: () => {},
      onFailed: failure,
      onChildWorkEvidence: committedEvidence(rig, rig.eventSink, () => {
        throw new Error('sink unavailable')
      }),
      onChildWorkFailure: failure
    })
    lane.dispose()
    await lane.written()
    lanes.push(throwing)
    throwing.apply(subagent(throwing, 'working'))
    throwing.apply(subagent(throwing, 'completed'))
    throwing.apply([{ type: 'turn.open', turn: 'turn', at: 2 }])
    expect(await throwing.written()).toEqual({ ok: true })
    const rows = await rig.rows()
    expect(rows.filter(({ body }) => body.kind !== 'semantic-work')).toHaveLength(1)
    expect(rows.filter(({ body }) => body.kind === 'semantic-work')).toMatchObject([
      { body: { phase: 'settled' } }
    ])
    expect(failure).not.toHaveBeenCalled()
    expect(reports).toHaveBeenCalledTimes(2)
    expect(
      reports.mock.calls.every(
        ([message, error]) =>
          message === '[agent-session] committed publication failed' &&
          error instanceof Error &&
          error.message === 'sink unavailable'
      )
    ).toBe(true)
  })

  it('releases live ownership when session-end admission is held and disposal ends observation', async () => {
    const { rig, lane, refused, delivery, owner } = await fixture()
    lane.apply(subagent(lane, 'working'))
    await rig.rows()
    expect(owner.childWorkOpen('session-timeline')).toBe(true)
    refused.value = true
    lane.apply([{ type: 'session.ended', verdict: { state: 'interrupted', completedAt: 20 } }])
    lane.dispose()
    await expect(lane.written()).resolves.toMatchObject({ ok: false })
    expect(owner.childWorkOpen('session-timeline')).toBe(false)
    await rig.rows()
    expect(delivery.flat().map((edge) => edge.type)).toEqual(['live'])
    lane.apply(subagent(lane, 'working'))
    lane.retry()
    await rig.rows()
    expect(delivery.flat().map((edge) => edge.type)).toEqual(['live'])
  })
})
