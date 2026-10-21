// A reopened chat catches up on turns its agent replays that the chat never saw, against real
// OpenCode 2.0.14 and Grok 1.0.62 recordings: once, in order, under one divider, and never a turn
// the chat already holds.

import { afterEach, describe, expect, it } from 'vitest'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import {
  AGENT,
  closeProviderTimelineRigs,
  NAMESPACE,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import { GROK_ACP_DIALECT } from './acp-dialects/grok-dialect'
import { OPENCODE_ACP_DIALECT } from './acp-dialects/opencode-dialect'
import { catchUpAcpHistory } from './acp-history-catch-up'
import type { AcpHistoryTurnIdentity } from './acp-history-replay'
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
      assertCurrent: () => {},
      now: () => 5_000
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

  it("never repeats an OpenCode send of the chat's own that failed before any reply", async () => {
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
})
