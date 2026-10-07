import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type {
  MobileNativeChatLiveLine,
  MobileNativeChatTurnRow
} from './use-mobile-native-chat-turn-disclosure'

export type MobileNativeChatPresentationEntry =
  | { kind: 'message'; key: string; message: NativeChatMessage; row: MobileNativeChatTurnRow }
  | { kind: 'live-status'; key: string; line: MobileNativeChatLiveLine }

/** Every message stays an item in this sequence, including one waiting behind a turn. */
export function mobileNativeChatPresentation({
  turns,
  streamingKey,
  presentationKeys
}: {
  turns: {
    listMessages: readonly NativeChatMessage[]
    waitingRows: readonly { item: NativeChatMessage; index: number }[]
    resolveRow: (index: number, message: NativeChatMessage) => MobileNativeChatTurnRow
    liveLine: MobileNativeChatLiveLine | null
  }
  streamingKey: string
  presentationKeys: Readonly<Record<string, string>>
}): MobileNativeChatPresentationEntry[] {
  const messageEntry = (
    message: NativeChatMessage,
    index: number
  ): MobileNativeChatPresentationEntry => ({
    kind: 'message',
    key: message.id === 'streaming' ? streamingKey : (presentationKeys[message.id] ?? message.id),
    message,
    row: turns.resolveRow(index, message)
  })
  return [
    ...turns.listMessages.map(messageEntry),
    ...(turns.liveLine
      ? [{ kind: 'live-status' as const, key: 'live-status', line: turns.liveLine }]
      : []),
    ...turns.waitingRows.map(({ item, index }) => messageEntry(item, index))
  ]
}
