import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../src/shared/agent-session-journal-types'
import { Harness, Result } from './use-mobile-native-chat-turn-disclosure.test-fixture'
import { mobileNativeChatPresentation } from './mobile-native-chat-presentation'

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalItemBody
): AgentJournalRenderItem {
  return {
    itemId,
    revision: 0,
    sequence,
    observedAt: sequence,
    turnScope: { kind: 'thread' },
    body
  }
}
const messages: NativeChatMessage[] = [
  {
    id: 'compact',
    role: 'user',
    blocks: [{ type: 'text', text: '/compact' }],
    timestamp: 0,
    source: 'hook'
  },
  {
    id: 'held',
    role: 'user',
    queued: true,
    blocks: [{ type: 'text', text: 'Waiting question' }],
    timestamp: 1,
    source: 'hook'
  }
]
function journal(state: 'running' | 'completed') {
  return {
    items: [
      item('compact', 1, {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: '/compact' }],
        command: { name: 'compact' }
      }),
      item('turn', 2, {
        kind: 'turn',
        turnId: 'compact:1',
        state,
        userItemId: 'compact',
        startedAt: 1
      }),
      item('held', 3, {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'Waiting question' }]
      })
    ],
    submissions: []
  }
}

describe('one derived virtualized presentation', () => {
  it('keeps waiting messages in the same entry and preserves live/settled ordering and original disclosure indices', () => {
    let renderer: ReturnType<typeof create>
    act(() => {
      renderer = create(
        createElement(Harness, { messages, enabled: true, turnJournal: journal('running') })
      )
    })
    const turns = renderer!.root.findByType(Result).props.disclosure
    const resolve = turns.resolveRow
    const indices: [number, string][] = []
    const running = mobileNativeChatPresentation({
      turns: {
        ...turns,
        resolveRow: (index, message) => {
          indices.push([index, message.id])
          return resolve(index, message)
        }
      },
      streamingKey: 'streaming:0',
      presentationKeys: {}
    })
    expect(running.map((entry) => entry.key)).toEqual(['compact', 'live-status', 'held'])
    expect(indices).toEqual([
      [0, 'compact'],
      [1, 'held']
    ])
    act(() =>
      renderer!.update(
        createElement(Harness, {
          messages,
          enabled: true,
          isWorking: false,
          turnJournal: journal('completed')
        })
      )
    )
    const settled = mobileNativeChatPresentation({
      turns: renderer!.root.findByType(Result).props.disclosure,
      streamingKey: 'streaming:0',
      presentationKeys: {}
    })
    expect(settled.map((entry) => entry.key)).toEqual(['compact', 'held'])
    expect(settled.find((entry) => entry.key === 'held')?.kind).toBe('message')
    act(() => renderer!.unmount())
  })
  it('does not rename authoritative entries with changing turn attribution', () => {
    let renderer: ReturnType<typeof create>
    act(() => {
      renderer = create(createElement(Harness, { messages, enabled: true }))
    })
    const before = mobileNativeChatPresentation({
      turns: renderer!.root.findByType(Result).props.disclosure,
      streamingKey: 'streaming:0',
      presentationKeys: {}
    })
    act(() =>
      renderer!.update(
        createElement(Harness, { messages, enabled: true, turnJournal: journal('running') })
      )
    )
    const after = mobileNativeChatPresentation({
      turns: renderer!.root.findByType(Result).props.disclosure,
      streamingKey: 'streaming:0',
      presentationKeys: {}
    })
    expect(before.filter((entry) => entry.kind === 'message').map((entry) => entry.key)).toEqual([
      'compact',
      'held'
    ])
    expect(after.filter((entry) => entry.kind === 'message').map((entry) => entry.key)).toEqual([
      'compact',
      'held'
    ])
    act(() => renderer!.unmount())
  })
})
