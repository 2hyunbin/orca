import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { applyCommandMarkerBoundaries } from './native-chat-command-marker'

it.each([' /CLEAR focus on tests ', '\u00a0/Clear\u2028arguments', '/clear\t\ud800'])(
  'recognizes a clear command token in %j',
  (command) => {
    const messages: NativeChatMessage[] = [
      {
        id: 'after',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'new answer' }],
        timestamp: 20,
        source: 'transcript'
      }
    ]
    expect(applyCommandMarkerBoundaries(messages, [{ id: 'c1', command, sentAt: 10 }])).toEqual(
      messages
    )
    expect(applyCommandMarkerBoundaries(messages, [{ id: 'c2', command, sentAt: 30 }])).toEqual([])
  }
)
