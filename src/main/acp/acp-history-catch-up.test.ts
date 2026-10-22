// A reopened chat catches up on turns its agent replays that the chat never saw, against real
// OpenCode 2.0.14 and Grok 1.0.62 recordings: once, in order, under one divider, and never a turn
// the chat already holds.

import { afterEach, describe, expect, it } from 'vitest'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import {
  AGENT,
  closeProviderTimelineRigs,
  NAMESPACE,
  SESSION,
  providerItemId
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import { GROK_ACP_DIALECT } from './acp-dialects/grok-dialect'
import { OPENCODE_ACP_DIALECT } from './acp-dialects/opencode-dialect'
import { agentJournalTurnBody, readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { acpNamedTextKey } from './acp-turn-messages'
import { isHistoricalProviderTimelineItem } from '../native-chat/agent-session-timeline/provider-timeline-history'
import { StructuredAgentSessionCurrentWork } from '../native-chat/agent-session-wire/structured-agent-session-current-work'
import { hasUnfinishedStructuredAgentSessionWork } from '../native-chat/agent-session-wire/structured-agent-session-unfinished-work'
import { planStructuredAgentSessionDeadGeneration } from '../native-chat/agent-session-wire/structured-agent-session-dead-generation-settlement'
import { catchUpAcpHistory } from './acp-history-catch-up'
import {
  AcpLoadHistory,
  type AcpLoadHistoryFrame,
  type AcpHistoryTurnIdentity
} from './acp-history-replay'
import { asReattachHistory } from './acp-structured-session'
import {
  openAcpFixtureRig,
  readAcpFixture,
  type AcpFixtureFrame
} from './acp-timeline-fixture.test-support'

afterEach(closeProviderTimelineRigs)

async function recording(name: string): Promise<AcpFixtureFrame[]> {
  // The rig's journal keys rows under its own provider session.
  return JSON.parse(
    JSON.stringify(await readAcpFixture(name)).replaceAll('"session-1"', JSON.stringify(NAMESPACE))
  )
}

/** What the chat's lane kept while process `process` replayed its history on load. */
function loadReplay(frames: AcpFixtureFrame[], process: string) {
  const own = frames.filter((frame) => frame.process === process)
  const load = own.findIndex((frame) => frame.message.method === 'session/load')
  const answered = own.findIndex((frame, index) => index > load && frame.message.id !== undefined)
  return own.slice(load + 1, answered).map((frame) => ({
    method: frame.message.method!,
    params: asReattachHistory(frame.message.params)
  }))
}

async function setup(dialect: AcpDialect, identity: AcpHistoryTurnIdentity) {
  const fixture = await openAcpFixtureRig(dialect)
  const catchUp = (frames: ReturnType<typeof loadReplay>) =>
    catchUpAcpHistory({
      frames,
      identity,
      sink: fixture.rig.eventSink,
      sessionId: SESSION,
      agent: AGENT,
      providerSessionId: NAMESPACE,
      dialect,
      assertCurrent: () => {}
    })
  return { fixture, catchUp }
}

function userTexts(rows: AgentJournalRenderItem[]): string[] {
  return rows.flatMap((row) =>
    row.body.kind === 'message' && row.body.role === 'user' && row.body.blocks[0]?.type === 'text'
      ? [row.body.blocks[0].text]
      : []
  )
}

function dividers(rows: AgentJournalRenderItem[]): AgentJournalRenderItem[] {
  return rows.filter(
    (row) => row.body.kind === 'status' && row.body.presentation?.startsWith('continued-outside')
  )
}

/** The chat's own send, as its row reads: the text a person typed. */
async function chatSend(
  fixture: Awaited<ReturnType<typeof openAcpFixtureRig>>,
  clientMessageId: string,
  text: string
) {
  const identity = parseAgentJournalItemKey(agentJournalSubmissionKey(clientMessageId))!
  await fixture.rig.journal.appendItem(
    identity,
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
}

function replayUpdate(
  sessionUpdate: string,
  rest: Record<string, unknown> = {}
): AcpLoadHistoryFrame {
  return {
    method: 'session/update',
    params: { sessionId: NAMESPACE, update: { sessionUpdate, ...rest } }
  }
}
const userReplay = (id: string, text = 'repeat') =>
  replayUpdate('user_message_chunk', {
    messageId: id,
    content: { type: 'text', text }
  })
const answerReplay = (text: string, id = 'answer') =>
  replayUpdate('agent_message_chunk', {
    messageId: id,
    content: { type: 'text', text }
  })

describe('ACP history catch-up', () => {
  it('adds an OpenCode turn made outside the chat once, completing it on a later open', async () => {
    const { fixture, catchUp } = await setup(OPENCODE_ACP_DIALECT, 'user-message-id')
    const frames = await recording('opencode-v2-reopen')
    const chat = frames.filter((frame) => frame.process === 'A')
    const prompts = chat.filter((frame) => frame.message.method === 'session/prompt')
    // The chat saw its first two turns; the third ran outside it.
    await fixture.feed(chat.slice(0, chat.indexOf(prompts[2]!)))
    const before = await fixture.rig.rows()
    await fixture.restart()
    const replay = loadReplay(frames, 'B')
    const outsideTool = replay.findLastIndex((frame) =>
      JSON.stringify(frame.params).includes('"tool_call"')
    )

    // Opened while the outside turn had only begun: it shows as far as it went.
    await catchUp(replay.slice(0, outsideTool))
    const partial = await fixture.rig.rows()
    expect(partial.slice(0, before.length).map((row) => row.itemId)).toEqual(
      before.map((row) => row.itemId)
    )
    const added = partial.slice(before.length)
    expect(added[0]?.body).toMatchObject({ kind: 'status', presentation: 'continued-outside' })
    expect(userTexts(added)).toEqual([expect.stringContaining('sleep 40')])

    await catchUp(replay)
    const complete = await fixture.rig.rows()
    expect(dividers(complete)).toHaveLength(1)
    expect(userTexts(complete)).toEqual([expect.stringContaining('sleep 40')])
    expect(complete.filter((row) => row.body.kind === 'tool-call')).toHaveLength(3)

    await catchUp(replay)
    expect(await fixture.rig.rows()).toEqual(complete)
  })

  it('retains unproven visible replay after an OpenCode native failure', async () => {
    const { fixture, catchUp } = await setup(OPENCODE_ACP_DIALECT, 'user-message-id')
    const frames = await recording('opencode-v2-reopen-outside')
    const prompt = frames.find((frame) => frame.message.method === 'session/prompt')
    await fixture.feed([prompt!])
    await chatSend(fixture, 'A:3', 'Reply with exactly the word ONE.')
    fixture.apply(fixture.lane().promptFailed('A:3', new Error('quota'), 1_100))
    await fixture.restart()

    await catchUp(loadReplay(frames, 'C'))
    const rows = await fixture.rig.rows()
    expect(userTexts(rows)).toEqual([
      'Reply with exactly the word ONE.',
      'Reply with exactly the word ONE.',
      expect.stringContaining('TWO-TOOL')
    ])
    expect(dividers(rows)).toHaveLength(1)
  })

  it('never repeats turns an OpenCode 2.x chat was adopted from', async () => {
    const { fixture, catchUp } = await setup(OPENCODE_ACP_DIALECT, 'user-message-id')
    const frames = await recording('opencode-v2-reopen-outside')
    const replay = loadReplay(frames, 'C')
    const adoptedId = JSON.stringify(replay[0]!.params).match(/msg_\w+/)![0]
    await fixture.rig.journal.appendItem(
      { provider: 'legacy', agent: AGENT, sessionId: NAMESPACE, recordId: `opencode:${adoptedId}` },
      {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'Reply with exactly the word ONE.' }]
      },
      { fence: 0, turnScope: { kind: 'thread' } }
    )

    await catchUp(replay)
    expect(userTexts(await fixture.rig.rows())).toEqual([
      'Reply with exactly the word ONE.',
      expect.stringContaining('TWO-TOOL')
    ])
  })

  it('adds a Grok turn made outside the chat under its own id, never the turn Orca sent', async () => {
    const { fixture, catchUp } = await setup(GROK_ACP_DIALECT, 'prompt-id')
    const frames = await recording('grok-v1-reopen-outside')
    await fixture.feed(frames.filter((frame) => frame.process === 'A'))
    await chatSend(fixture, 'A:3', 'Reply with exactly the word ONE.')
    await fixture.restart()

    await catchUp(loadReplay(frames, 'C'))
    const rows = await fixture.rig.rows()
    expect(userTexts(rows)).toEqual([
      'Reply with exactly the word ONE.',
      expect.stringContaining('TWO-TOOL')
    ])
    expect(dividers(rows)).toHaveLength(1)
    expect((await fixture.rig.turns()).map((turn) => turn.state)).toEqual([
      'completed',
      'completed'
    ])
  })
  it('refreshes same-key bodies after restart without inventing execution ownership or a new divider', async () => {
    const { fixture, catchUp } = await setup(OPENCODE_ACP_DIALECT, 'user-message-id')
    const { rig } = fixture
    await rig.journal.appendSubmission({
      clientMessageId: 'native',
      payloadFingerprint: 'native',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'my native prompt' }] },
      fence: 1
    })
    await rig.journal.resolveDispatch({
      clientMessageId: 'native',
      fence: 1,
      state: 'accepted',
      providerIdentity: null
    })
    rig.assembler.apply({
      type: 'input.accepted',
      clientMessageId: 'native',
      requestedAt: 1000,
      join: { turn: 'native-turn' }
    })
    rig.assembler.apply({ type: 'turn.open', turn: 'native-turn', at: 1000 })
    rig.assembler.apply({ type: 'turn.end', turn: 'native-turn', state: 'completed', at: 1100 })
    const nativeBefore = await rig.rows()
    const source = 'external-'.repeat(40)
    const tool = replayUpdate('tool_call', {
      toolCallId: 'tool',
      name: 'shell',
      title: 'shell',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'sleep 40' }
    })
    const partial = [userReplay(source), answerReplay('prefix'), tool]
    await catchUp(partial)
    const imported = await rig.rows()
    const historical = imported.filter((item) =>
      isHistoricalProviderTimelineItem(item, (key) => rig.journal.item(key))
    )
    expect(historical).toHaveLength(4)
    const container = historical.map((item) => readAgentJournalTurn(item.body)).find(Boolean)
    expect(container).toMatchObject({ state: 'completed' })
    expect(container).not.toHaveProperty('outcome')
    expect(container).not.toHaveProperty('completedAt')
    expect(container).not.toHaveProperty('startedAt')
    const observedTool = historical.find((item) => item.body.kind === 'tool-call')!
    expect(observedTool.body).toMatchObject({ state: 'running' })
    expect(
      new StructuredAgentSessionCurrentWork(rig.journal, 1).isCurrentItem(observedTool.itemId)
    ).toBe(false)
    expect(hasUnfinishedStructuredAgentSessionWork(rig.journal)).toBe(false)
    expect(
      planStructuredAgentSessionDeadGeneration({
        journal: rig.journal,
        sessionId: SESSION,
        fence: 1,
        settlementId: 'exit',
        verdict: { state: 'interrupted' },
        pendingSubmissionReason: 'ended'
      }).mutations
    ).toEqual([])
    rig.assembler.apply({ type: 'session.ended', verdict: { state: 'interrupted' }, endedAt: 9000 })
    await fixture.restart()
    expect((await rig.row(observedTool.itemId))?.body).toEqual(observedTool.body)
    const completed = replayUpdate('tool_call_update', {
      toolCallId: 'tool',
      status: 'completed',
      rawOutput: 'done',
      content: [{ type: 'content', content: { type: 'text', text: 'done' } }]
    })
    const full = [
      userReplay(source),
      answerReplay('prefix and full tail'),
      tool,
      completed,
      answerReplay('second', 'answer-2')
    ]
    await catchUp(full)
    const complete = await rig.rows()
    expect(complete.slice(0, nativeBefore.length)).toEqual(nativeBefore)
    const revised = complete.find((row) => row.itemId === observedTool.itemId)!
    expect(revised.body).toMatchObject({ state: 'completed' })
    expect(revised.sequence).toBe(observedTool.sequence)
    expect(revised.revision).toBe(observedTool.revision + 1)
    expect(
      complete
        .filter((row) => row.body.kind === 'message' && row.body.role === 'assistant')
        .map((row) => row.body)
    ).toMatchObject([
      { blocks: [{ text: 'prefix and full tail' }] },
      { blocks: [{ text: 'second' }] }
    ])
    expect(dividers(complete)).toHaveLength(1)
    await catchUp(full)
    expect(await rig.rows()).toEqual(complete)
    const reopened = await rig.reopenJournal()
    expect(
      isHistoricalProviderTimelineItem(reopened.item(observedTool.itemId)!, (key) =>
        reopened.item(key)
      )
    ).toBe(true)
    expect(isHistoricalProviderTimelineItem(nativeBefore[0]!, (key) => reopened.item(key))).toBe(
      false
    )
  })

  it('keeps same-text outside answers and reasoning while deduplicating exact native output', async () => {
    const { fixture, catchUp } = await setup(OPENCODE_ACP_DIALECT, 'user-message-id')
    const { rig } = fixture
    await chatSend(fixture, 'native', 'repeat')
    rig.assembler.apply({
      type: 'input.accepted',
      clientMessageId: 'native',
      requestedAt: 1000,
      join: { turn: 'native-turn' }
    })
    rig.assembler.apply({ type: 'turn.open', turn: 'native-turn', at: 1000 })
    rig.assembler.apply({
      type: 'text.delta',
      item: { id: acpNamedTextKey('native-answer', 'assistant') },
      channel: 'assistant',
      text: 'native answer',
      join: { thread: NAMESPACE, turn: 'native-turn' }
    })
    rig.assembler.flush()
    rig.assembler.apply({ type: 'turn.end', turn: 'native-turn', state: 'completed', at: 1100 })
    const native = await rig.rows()
    const reasoning = replayUpdate('agent_thought_chunk', {
      messageId: 'thought:reasoning:0',
      content: { type: 'text', text: 'outside reasoning' }
    })
    await catchUp([
      userReplay('native-provider-id'),
      answerReplay('native answer', 'native-answer'),
      userReplay('outside'),
      answerReplay('outside answer'),
      userReplay('outside-thought'),
      reasoning
    ])
    const rows = await rig.rows()
    expect(rows.slice(0, native.length)).toEqual(native)
    expect(userTexts(rows)).toEqual(['repeat', 'repeat', 'repeat'])
    expect(
      rows.filter((row) => row.body.kind === 'message' && row.body.role === 'reasoning')
    ).toHaveLength(1)
    expect(dividers(rows)).toHaveLength(1)
    expect(
      rows.filter(
        (row) =>
          row.itemId ===
          providerItemId('item', acpNamedTextKey('native-answer', 'assistant'), {
            thread: NAMESPACE
          })
      )
    ).toHaveLength(1)
    await chatSend(fixture, 'other', 'other')
    rig.assembler.apply({
      type: 'input.accepted',
      clientMessageId: 'other',
      requestedAt: 2000,
      join: { turn: 'other' }
    })
    rig.assembler.apply({ type: 'turn.open', turn: 'other', at: 2000 })
    rig.assembler.apply({
      type: 'text.delta',
      item: { id: acpNamedTextKey('other-answer', 'assistant') },
      channel: 'assistant',
      text: 'other answer',
      join: { thread: NAMESPACE, turn: 'other' }
    })
    rig.assembler.flush()
    rig.assembler.apply({ type: 'turn.end', turn: 'other', state: 'completed', at: 2100 })
    const beforeConflict = await rig.rows()
    await catchUp([
      userReplay('conflict'),
      answerReplay('native answer', 'native-answer'),
      answerReplay('other answer', 'other-answer')
    ])
    expect(await rig.rows()).toEqual(beforeConflict)
  })

  it('uses Grok handover proof without claiming a never-handed-over queued send', async () => {
    const { fixture, catchUp } = await setup(GROK_ACP_DIALECT, 'prompt-id')
    const { journal } = fixture.rig
    for (const id of ['handed', 'queued']) {
      await journal.appendSubmission({
        clientMessageId: id,
        payloadFingerprint: id,
        fence: 1,
        handoverRecorded: true,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'repeat' }] }
      })
    }
    await journal.resolveDispatch({
      clientMessageId: 'handed',
      fence: 1,
      state: 'pending',
      turnScope: { kind: 'thread' }
    })
    const submissions = journal.submissions()
    const replay = ['handed', 'queued'].flatMap((id) => [
      userReplay(id),
      {
        method: 'session/update',
        params: {
          sessionId: NAMESPACE,
          _meta: { promptId: `prompt:${id}` },
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: id } }
        }
      }
    ])
    await catchUp(replay)
    expect(journal.submissions()).toEqual(submissions)
    expect(userTexts(await fixture.rig.rows())).toEqual(['repeat', 'repeat', 'repeat'])
    expect(journal.receiptFor('queued')).toBeNull()
    expect(journal.submission('queued')?.dispatchState).toBe('pending')
    expect(journal.submission('queued')?.handedOverAt).toBeUndefined()
  })
  it.each(['refused', 'direct', 'queued', 'card', 'empty'] as const)(
    'places the divider from visible retained content with a %s submission',
    async (scenario) => {
      const { fixture, catchUp } = await setup(GROK_ACP_DIALECT, 'prompt-id')
      const { journal } = fixture.rig
      await journal.appendSubmission({
        clientMessageId: 'retained',
        payloadFingerprint: 'retained',
        fence: 1,
        ...(scenario === 'direct' ? {} : { handoverRecorded: true }),
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: scenario === 'empty' ? '' : 'keep my message' }]
        }
      })
      if (scenario !== 'direct' && scenario !== 'queued') {
        await journal.resolveDispatch({
          clientMessageId: 'retained',
          fence: 1,
          state: 'pending',
          turnScope: { kind: 'thread' }
        })
      }
      if (scenario === 'refused' || scenario === 'card') {
        await journal.resolveDispatch({
          clientMessageId: 'retained',
          fence: 1,
          state: 'rejected',
          ...agentSessionFailureWords(agentSessionFailureFact('providerRejected'), {
            surface: 'rejection'
          }),
          ...(scenario === 'card' ? { keptAsQueuedMessageId: 'card' } : {})
        })
      }
      const before = await fixture.rig.rows()
      const submissions = journal.submissions()
      const replay = [
        userReplay('outside'),
        {
          method: 'session/update',
          params: {
            sessionId: NAMESPACE,
            _meta: { promptId: 'outside' },
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'answer' }
            }
          }
        }
      ]
      await catchUp(replay)
      const rows = await fixture.rig.rows()
      expect(dividers(rows)).toHaveLength(scenario === 'refused' || scenario === 'direct' ? 1 : 0)
      expect(rows.slice(0, before.length)).toEqual(before)
      expect(journal.submissions()).toEqual(submissions)
      await catchUp(replay)
      expect(await fixture.rig.rows()).toEqual(rows)
    }
  )
  it.each(['queued-only', 'ownership-revision'] as const)(
    'captures immutable coverage before concurrent %s',
    async (scenario) => {
      const { fixture, catchUp } = await setup(OPENCODE_ACP_DIALECT, 'user-message-id')
      const { rig } = fixture
      const replay = [userReplay('outside'), answerReplay('prefix')]
      await catchUp(replay)
      const turn = (await rig.rows()).find((item) => item.body.kind === 'turn')!
      const append = rig.eventSink.tryAppendTransition!
      let intervened = false
      rig.eventSink.tryAppendTransition = (transition) => {
        if (!intervened) {
          intervened = true
          if (scenario === 'queued-only') {
            void rig.journal.appendSubmission({
              clientMessageId: 'queued',
              payloadFingerprint: 'queued',
              fence: 1,
              handoverRecorded: true,
              body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'next' }] }
            })
          } else {
            void rig.journal.appendItem(
              parseAgentJournalItemKey(turn.itemId)!,
              agentJournalTurnBody({
                ...readAgentJournalTurn(turn.body)!,
                userItemId: 'orca:concurrent-owner'
              }),
              { fence: 1, turnScope: { kind: 'thread' } }
            )
          }
        }
        return append(transition)
      }
      await catchUp([userReplay('outside'), answerReplay('full')])
      expect(intervened).toBe(true)
      const answer = (await rig.rows()).find(
        (item) => item.body.kind === 'message' && item.body.role === 'assistant'
      )
      expect(answer?.body).toMatchObject({
        blocks: [{ text: scenario === 'queued-only' ? 'full' : 'prefix' }]
      })
      if (scenario === 'queued-only') {
        expect(rig.journal.submission('queued')?.handedOverAt).toBeUndefined()
      }
    }
  )
  it('bounds replay by UTF-8 bytes before staging', () => {
    const history = new AcpLoadHistory(NAMESPACE)
    history.keep('session/update', {
      sessionId: NAMESPACE,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '🙂'.repeat(4 * 1024 * 1024) }
      }
    })
    expect(history.frames()).toBeNull()
  })
})
