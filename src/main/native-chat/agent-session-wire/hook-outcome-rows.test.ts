// Captured prompt-hook blocks through each agent's translator, the journal, a reopen and the fold:
// one warning row stays on screen, nothing else explains the turn, and the send on record stays.

import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { withNativeChatCutTurnNotices } from '../../../shared/native-chat-cut-turn-notice'
import { nativeChatRowTurnKeys } from '../../../shared/native-chat-turn-grouping'
import { nativeChatTurnFold, nativeChatTurnFoldRow } from '../../../shared/native-chat-turn-fold'
import { projectStructuredItemsToNativeChat } from '../../../shared/structured-agent-session-projection'
import { GROK_ACP_DIALECT } from '../../acp/acp-dialects/grok-dialect'
import { readAcpFixture } from '../../acp/acp-timeline-fixture.test-support'
import { AcpTimelineTranslator } from '../../acp/acp-timeline-translator'
import { PromptResponseSchema } from '../../acp/generated/acp-protocol.generated'
import { createClaudeJournalTranslator } from '../../claude/claude-structured-journal-translation'
import { createCodexJournalTranslator } from '../../codex/codex-structured-journal-translation'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  type ProviderTimelineRig
} from '../agent-session-timeline/provider-timeline-assembler-test-support'
import type { ProviderTimelineEvent } from '../agent-session-timeline/provider-timeline-event'

const row = (text: string) =>
  expect.objectContaining({ tone: 'warning', presentation: 'turn-notice', text })
const DEPLOYS_FROZEN = row('Blocked by hook: Deploys are frozen')
const CODEX_CHAT = { agent: 'codex' as const, providerHandle: codexProviderHandle('t') }
const CLAUDE_CHAT = { agent: 'claude' as const, providerHandle: claudeProviderHandle('p', 'l') }
const QA_POLICY = 'QA policy: BLOCKME prompts are not allowed'
const SEND = { clientMessageId: 'cm-1', payloadFingerprint: 'fp', fence: 1 }
const GO = [{ type: 'text' as const, text: 'go' }]
type Captured = { method: string; params: Record<string, unknown>; frame: Record<string, unknown> }

afterEach(closeProviderTimelineRigs)

async function captured<T>(agent: 'codex' | 'claude', scenario: string): Promise<T[]> {
  const url = new URL(`../../${agent}/__fixtures__/${agent}-hook-outcomes.jsonl`, import.meta.url)
  const lines = (await readFile(url, 'utf8')).trim().split('\n')
  return lines.map((line) => JSON.parse(line)).filter((line) => line.case === scenario)
}

/** The system rows a settled chat draws, every turn folded. */
function settledRows(items: readonly AgentJournalRenderItem[]) {
  expect(withNativeChatCutTurnNotices(items, { agentName: 'Agent' })).toBe(items)
  const messages = projectStructuredItemsToNativeChat(items)
  const turnKeys = nativeChatRowTurnKeys(messages)
  const { foldedRows } = nativeChatTurnFold({
    rows: messages.map((message, index) => nativeChatTurnFoldRow(message, turnKeys[index], false)),
    settledTurnKeys: new Set(turnKeys.flatMap((key) => (key ? [key] : []))),
    expandedTurnKeys: new Set()
  })
  return messages.flatMap((message, index) =>
    message.role === 'system' && !foldedRows.has(index) ? message.blocks : []
  )
}

/** A chat whose send is on record, written by `write`, then read back by a fresh journal. */
async function blockedChat(
  identity: Parameters<typeof openProviderTimelineRig>[1],
  write: (rig: ProviderTimelineRig) => void
) {
  const rig = await openProviderTimelineRig({}, identity)
  await rig.journal.appendSubmission({
    ...SEND,
    body: { kind: 'message', role: 'user', blocks: GO }
  })
  const sent = rig.journal.snapshot().submissions
  write(rig)
  const { items, submissions } = (await rig.reopenJournal()).snapshot()
  expect(submissions).toEqual(sent)
  return items
}

describe('a prompt hook that blocked the message', () => {
  // A blocked tool call reaches the model as the tool's result, and writes no row of its own.
  it.each([
    ['blocked-prompt', [DEPLOYS_FROZEN]],
    ['blocked-steer', [DEPLOYS_FROZEN]],
    ['blocked-tool', []]
  ])('Codex %s', async (scenario, rows) => {
    const frames = await captured<Captured>('codex', scenario)
    const items = await blockedChat(CODEX_CHAT, (rig) => {
      const sink = rig.eventSink
      const lane = createCodexJournalTranslator({ sink, schedule: (run) => (run(), () => {}) })
      for (const { method, params } of frames) {
        const frame = { method, params: { ...params, threadId: 't' } }
        lane.handle({ type: 'notification', sessionId: 's', threadId: 't', ...frame })
      }
    })
    expect(settledRows(items)).toEqual(rows)
  })

  it.each([
    ['2.1.302', { kind: 'blocked_by_hook', reason: 'Deploys are frozen' }, null, DEPLOYS_FROZEN],
    [
      '2.1.302, a plugin module refused it',
      { kind: 'not_passed_on' },
      null,
      row('Blocked by hook.')
    ],
    ['older', undefined, null, DEPLOYS_FROZEN],
    ['older, no reason', undefined, '', row('Blocked by hook.')]
  ])('Claude %s', async (_, outcome, hooks, expected) => {
    const frames = await captured<Captured>('claude', 'blocked-prompt')
    const items = await blockedChat(CLAUDE_CHAT, (rig) => {
      const lane = createClaudeJournalTranslator({ sink: rig.eventSink, fallbackIdPrefix: '1' })
      for (const { frame } of frames) {
        const message: Record<string, unknown> = { ...frame, prompt_submit_outcome: outcome }
        if (hooks !== null && typeof frame.content === 'string') {
          message.content = frame.content.replace(/\[.*\]: .*/, hooks)
        }
        lane.handle({ type: 'message', sessionId: 's', message })
      }
    })
    expect(settledRows(items)).toEqual([expected])
  })

  it.each([
    ['its end alone', ['end']],
    ['its answer alone', ['answer']],
    ['its end, then its answer', ['end', 'answer']],
    ['its answer, then its end', ['answer', 'end']]
  ])('Grok, %s', async (_, order) => {
    const frames = await readAcpFixture('grok-hook-denied')
    const isEnd = (frame: unknown) => JSON.stringify(frame).includes('"turn_completed"')
    const answer = frames.find((frame) => frame.message.result !== undefined)
    const notices = frames.filter((frame) => frame.message.id === undefined && !isEnd(frame))
    const steps = order.flatMap((step) => (step === 'answer' ? [answer!] : frames.filter(isEnd)))
    const events: ProviderTimelineEvent[] = []
    const items = await blockedChat({}, (rig) => {
      const lane = new AcpTimelineTranslator({ sessionId: 'session-1', dialect: GROK_ACP_DIALECT })
      const apply = (next: ProviderTimelineEvent[]) => {
        events.push(...next)
        next.forEach((event) => expect(rig.assembler.apply(event).admission.accepted).toBe(true))
      }
      apply(lane.openPrompt('p1:3', 1_000).events)
      for (const { message } of [...notices, ...steps]) {
        apply(
          message.result === undefined
            ? lane.notification(message.method ?? '', message.params, 2_000)
            : lane.promptResult('p1:3', PromptResponseSchema.parse(message.result), 2_000)
        )
      }
    })
    const accepted = events.filter((event) => event.type === 'input.accepted')
    expect(accepted).toEqual([expect.objectContaining({ clientMessageId: 'p1:3' })])
    const ended = events.findIndex((event) => event.type === 'turn.end')
    expect(events.indexOf(accepted[0]!)).toBeLessThan(ended)
    const turns = items.flatMap((item) => readAgentJournalTurn(item.body) ?? [])
    expect(turns).toEqual([expect.objectContaining({ state: 'completed', outcome: 'success' })])
    expect(settledRows(items)).toEqual([row(`Blocked by hook: ${QA_POLICY}`)])
  })
})
