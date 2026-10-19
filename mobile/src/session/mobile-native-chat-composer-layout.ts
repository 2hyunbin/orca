import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

/** Tool calls in the loaded transcript; the Tools toggle is offered only when there are some. */
export function mobileNativeChatToolCallCount(messages: readonly NativeChatMessage[]): number {
  let count = 0
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool-call') {
        count += 1
      }
    }
  }
  return count
}
