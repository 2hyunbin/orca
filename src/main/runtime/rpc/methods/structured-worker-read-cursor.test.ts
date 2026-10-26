import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session-record.test-fixture'
import { agentSessionConversationView } from '../../../../shared/agent-session-conversation-view'
/** Mutate journals between reads: streaming revisions, mid-array insertions and window slides must neither duplicate nor churn the cursor. */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { StructuredWorkerIdentity } from '../../structured-worker-identity'

const hostRef: { current: unknown } = { current: null }

vi.mock('../../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { readStructuredWorkerJournal } = await import('./orchestration-structured-worker-lifecycle')

const IDENTITY: StructuredWorkerIdentity = {
  handle: 'structworker_1',
  sessionId: 'session-1',
  agent: 'claude',
  paneKey: 'structured-agent-session-session-1:11111111-1111-4111-a111-111111111111',
  processIncarnation: 'structured:session-1',
  worktreeId: 'wt_1',
  hostScope: { kind: 'local', hostId: 'local' }
}

function message(itemId: string, text: string, revision = 1): AgentJournalRenderItem {
  return {
    itemId,
    revision,
    sequence: Number(itemId.slice(1)),
    observedAt: 1,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
  } as unknown as AgentJournalRenderItem
}

/** Projects to null while pending, and to a system message once resolved — mid-array. */
function approval(itemId: string, resolved: boolean, revision = 1): AgentJournalRenderItem {
  return {
    itemId,
    revision,
    sequence: Number(itemId.slice(1)),
    observedAt: 1,
    body: {
      kind: 'approval',
      title: 'run it?',
      detail: null,
      resolution: { state: resolved ? 'approved' : 'pending' }
    }
  } as unknown as AgentJournalRenderItem
}

function installJournal(items: AgentJournalRenderItem[]): void {
  hostRef.current = {
    deps: {
      store: {
        getConversation: () =>
          agentSessionConversationView(
            agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: IDENTITY.sessionId }))
          )
      }
    },
    hasSession: () => true,
    history: () => ({ page: { items, hasOlder: false } })
  }
}

function read(cursor?: string, limit?: number) {
  return readStructuredWorkerJournal({
    identity: IDENTITY,
    dispatchId: 'd1',
    workerState: 'ready',
    liveness: 'live',
    agent: 'claude',
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit })
  })
}

function textsOf(result: Awaited<ReturnType<typeof read>>): string[] {
  return result.transcript.messages.map((entry) =>
    entry.blocks.map((block) => ('text' in block ? block.text : '')).join('')
  )
}

describe('the structured worker-read cursor over a mutating journal', () => {
  beforeEach(() => {
    hostRef.current = null
  })

  it('starts at the newest messages and says older ones are not pageable', async () => {
    installJournal([message('i1', 'a'), message('i2', 'b'), message('i3', 'c')])
    const first = await read(undefined, 2)
    expect(textsOf(first)).toEqual(['b', 'c'])
    expect(first.contentComplete).toBe(false)
    expect(first.clipping).toEqual(['message_limit_or_scan_window'])
    expect(textsOf(await read(first.cursor))).toEqual([])
  })

  it('re-sends the last delivered message when it was revised while streaming', async () => {
    // A tool call gaining its result revised a delivered item; the prefix-hash cursor refused every later read.
    installJournal([message('i1', 'first'), message('i2', 'hel')])
    const first = await read()
    expect(textsOf(first)).toEqual(['first', 'hel'])

    installJournal([message('i1', 'first'), message('i2', 'hello world', 2), message('i3', 'next')])
    const second = await read(first.cursor)
    expect(textsOf(second)).toEqual(['hello world', 'next'])
    expect(second.sourceIdentity).toBe(first.sourceIdentity)

    expect(textsOf(await read(second.cursor))).toEqual([])
  })

  it('does not duplicate when a resolved prompt appears behind the cursor', async () => {
    // Resolving an approval inserts a message mid-array; a position cursor re-sent a delivered message.
    installJournal([message('i1', 'first'), approval('i2', false), message('i3', 'second')])
    const first = await read()
    expect(textsOf(first)).toEqual(['first', 'second'])

    installJournal([message('i1', 'first'), approval('i2', true, 2), message('i3', 'second')])
    expect(textsOf(await read(first.cursor))).toEqual([])
  })

  it('pages new messages forward exactly once', async () => {
    installJournal([message('i1', 'a')])
    const first = await read()
    installJournal([message('i1', 'a'), message('i2', 'b'), message('i3', 'c')])
    const second = await read(first.cursor, 1)
    expect(second.transcript.limited).toBe(true)
    const third = await read(second.cursor, 1)
    expect(third.contentComplete).toBe(true)
    expect([...textsOf(first), ...textsOf(second), ...textsOf(third)]).toEqual(['a', 'b', 'c'])
  })

  it('follows the cursor while the window slides, and refuses once its message leaves', async () => {
    installJournal([message('i1', 'a'), message('i2', 'b')])
    const first = await read()
    installJournal([message('i2', 'b'), message('i3', 'c')])
    const second = await read(first.cursor)
    expect(textsOf(second)).toEqual(['c'])

    installJournal([message('i4', 'd'), message('i5', 'e')])
    await expect(read(second.cursor)).rejects.toThrow(/without --cursor/)
    expect(textsOf(await read())).toEqual(['d', 'e'])
  })
})
