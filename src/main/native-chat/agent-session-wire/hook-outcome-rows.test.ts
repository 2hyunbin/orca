// A prompt hook that blocked the message, for every agent that reports one: captured frames through
// the agent's real translator, the on-disk journal, a reopen, the projection and the fold. Each shows
// one warning row that stays on screen and explains nothing else away; the send's receipt is as before.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import {
  codexProviderHandle,
  claudeProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { withNativeChatCutTurnNotices } from '../../../shared/native-chat-cut-turn-notice'
import { nativeChatRowTurnKeys } from '../../../shared/native-chat-turn-grouping'
import { nativeChatTurnFold, nativeChatTurnFoldRow } from '../../../shared/native-chat-turn-fold'
import { projectStructuredItemsToNativeChat } from '../../../shared/structured-agent-session-projection'
import { openAcpFixtureRig, readAcpFixture } from '../../acp/acp-timeline-fixture.test-support'
import { PromptResponseSchema } from '../../acp/generated/acp-protocol.generated'
import { createClaudeJournalTranslator } from '../../claude/claude-structured-journal-translation'
import { createCodexJournalTranslator } from '../../codex/codex-structured-journal-translation'
import { closeProviderTimelineRigs } from '../agent-session-timeline/provider-timeline-assembler-test-support'
import type { ProviderTimelineEvent } from '../agent-session-timeline/provider-timeline-event'
import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener
} from '../agent-session-journal/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { testEventSinkLogging } from './structured-agent-session-logger-test-support'

const BLOCKED = 'Blocked by hook: Deploys are frozen'
const journals = createTrackedJournalOpener()
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  await journals.closeAll()
  await closeProviderTimelineRigs()
})

async function captured<T>(url: URL, scenario: string): Promise<T[]> {
  const lines = (await readFile(url, 'utf8')).trim().split('\n')
  return lines.map((line) => JSON.parse(line)).filter((line) => line.case === scenario)
}

/** A chat the user sent `cm-1` in, written by a lane and read back as a fresh process would. */
async function chat(agent: 'codex' | 'claude') {
  const root = await mkdtemp(join(tmpdir(), 'orca-hook-outcome-'))
  const options = {
    identity: {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent,
      providerHandle:
        agent === 'codex'
          ? codexProviderHandle('thread-1')
          : claudeProviderHandle('provider-1', 'leaf-1')
    },
    stateDirectory: root,
    now: () => 1_000
  }
  const journal = await journals.open(options)
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  deferred.bind({ journal, fence: 1, publish: () => {} })
  cleanups.push(async () => {
    deferred.close()
    await rm(root, { recursive: true, force: true })
  })
  const send = (clientMessageId: string) =>
    journal.appendItem(
      { provider: 'orca', clientMessageId },
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] },
      { fence: 1, turnScope: { kind: 'thread' } }
    )
  await send('cm-1')
  return {
    sink: deferred.sink,
    send,
    drained: () => deferred.drained(),
    reopen: async () => {
      await deferred.drained()
      const before = journal.snapshot()
      await journal.close()
      closeTestJournalHostDatabase(root)
      return { before, after: (await journals.open(options)).snapshot() }
    }
  }
}

/** What a settled chat draws: every row after the fold, each turn closed. */
function settledView(items: readonly AgentJournalRenderItem[]) {
  const read = withNativeChatCutTurnNotices(items, { agentName: 'Agent' })
  expect(read).toBe(items)
  const messages = projectStructuredItemsToNativeChat(read)
  const turnKeys = nativeChatRowTurnKeys(messages)
  const { foldedRows } = nativeChatTurnFold({
    rows: messages.map((message, index) => nativeChatTurnFoldRow(message, turnKeys[index], false)),
    settledTurnKeys: new Set(turnKeys.flatMap((key) => (key ? [key] : []))),
    expandedTurnKeys: new Set()
  })
  const visible = messages.filter((_, index) => !foldedRows.has(index))
  return visible.flatMap((message) => (message.role === 'system' ? message.blocks : []))
}

const HOOK_ROW = expect.objectContaining({
  tone: 'warning',
  presentation: 'hook-outcome',
  text: BLOCKED
})

describe('a prompt hook that blocked the message', () => {
  // A blocked tool call reaches the model as the tool's result, and writes no row of its own.
  it.each([
    ['blocked-prompt', [HOOK_ROW]],
    ['blocked-steer', [HOOK_ROW]],
    ['blocked-tool', []]
  ])('Codex %s', async (name, rows) => {
    const frames = await captured<{ method: string; params: Record<string, unknown> }>(
      new URL('../../codex/__fixtures__/codex-hook-outcomes.jsonl', import.meta.url),
      name
    )
    const lane = await chat('codex')
    const bound: string[][] = []
    const translator = createCodexJournalTranslator({
      sink: lane.sink,
      sessionId: 'session-1',
      primaryThreadId: () => 'thread-1',
      bindPromptItemId: (...args) => bound.push(args),
      schedule: (run) => (run(), () => {})
    })
    frames.forEach(({ method, params }, index) =>
      translator.handle({
        type: 'notification',
        sessionId: 'session-1',
        threadId: 'thread-1',
        method,
        params: { ...params, threadId: 'thread-1' },
        observedAt: 2_000 + index
      })
    )
    const { before, after } = await lane.reopen()
    expect(after.items).toEqual(before.items)
    expect(settledView(after.items)).toEqual(rows)
    // Receipt as on main for these frames: nothing bound, no submission touched.
    expect(bound).toEqual([])
    expect(after.submissions).toEqual([])
  })

  it.each(['blocked-prompt', 'blocked-queued-prompt'])('Claude %s', async (name) => {
    const frames = await captured<{ frame: Record<string, unknown> }>(
      new URL('../../claude/__fixtures__/claude-hook-outcomes.jsonl', import.meta.url),
      name
    )
    const lane = await chat('claude')
    const translator = createClaudeJournalTranslator({ sink: lane.sink, fallbackIdPrefix: '1' })
    for (const { frame } of frames) {
      if (frame.subtype === 'informational' && name === 'blocked-queued-prompt') {
        await lane.drained()
        await lane.send('cm-2')
      }
      translator.handle({ type: 'message', sessionId: 'orca-session', message: frame })
      await lane.drained()
    }
    const { after } = await lane.reopen()
    expect(settledView(after.items)).toEqual([HOOK_ROW])
    expect(after.submissions).toEqual([])
  })

  it.each([
    ['the answer alone', ['answer']],
    ['its end, then the answer', ['end', 'answer']],
    ['the answer, then a late end', ['answer', 'end']]
  ])('Grok, %s: a completed turn, accepted once', async (_, order) => {
    // Source-derived: no Grok sign-in works under a throwaway home, so these frames follow the
    // shape Grok's own source writes for a hook-denied prompt.
    const [prompt, , end, answer] = await readAcpFixture('grok-hook-denied.source-derived')
    expect(prompt?.message.method).toBe('session/prompt')
    const fixture = await openAcpFixtureRig()
    const lane = fixture.lane()
    const events: ProviderTimelineEvent[] = []
    const apply = (next: ProviderTimelineEvent[]) => {
      events.push(...next)
      fixture.apply(next)
    }
    apply(lane.openPrompt('p1:3', 1_000).events)
    for (const [index, step] of order.entries()) {
      apply(
        step === 'answer'
          ? lane.promptResult('p1:3', PromptResponseSchema.parse(answer?.message.result), 1_001)
          : lane.notification(end!.message.method!, end!.message.params, 1_001 + index)
      )
    }
    const accepted = events.filter((event) => event.type === 'input.accepted')
    expect(accepted).toEqual([expect.objectContaining({ clientMessageId: 'p1:3' })])
    expect(events.indexOf(accepted[0]!)).toBeLessThan(
      events.findIndex((event) => event.type === 'turn.end')
    )
    const items = (await fixture.rig.reopenJournal()).snapshot().items
    const turns = items.flatMap((item) => readAgentJournalTurn(item.body) ?? [])
    expect(turns).toEqual([expect.objectContaining({ state: 'completed', outcome: 'success' })])
    // The rig's journal holds only what the lane wrote; the user's bubble is the host's own row.
    const user = { itemId: 'user', revision: 1, sequence: 0, observedAt: 0 }
    const bubble = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'go' }]
    }
    expect(settledView([{ ...user, body: bubble }, ...items])).toEqual([HOOK_ROW])
  })
})
