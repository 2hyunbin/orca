import { useContext, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import {
  truncateToolDetail,
  MAX_TOOL_DETAIL_LENGTH
} from '../../../src/shared/native-chat-tool-summary'
import { isTextBlock, type NativeChatMessage } from '../../../src/shared/native-chat-types'
import { styles } from './mobile-native-chat-message-styles'
import {
  MobileNativeChatItemSourceContext,
  readMobileNativeChatItem,
  type MobileNativeChatItemBody
} from './mobile-native-chat-item-read'

// "Show full output" and "Show full message": a row the phone was sent a head of, read whole from
// the host that keeps it. State is the row's own, so a live revision never fights it.

type Load = 'idle' | 'loading' | 'failed'

function ShowFull({
  label,
  load,
  onPress
}: {
  label: string
  load: Load
  onPress: () => void
}): React.JSX.Element {
  return (
    <Pressable
      style={styles.showFull}
      onPress={onPress}
      disabled={load === 'loading'}
      hitSlop={8}
      accessibilityRole="button"
    >
      <Text style={styles.showFullText}>
        {load === 'failed' ? `${label} — couldn't load, tap to retry` : label}
      </Text>
    </Pressable>
  )
}

function outputOf(body: MobileNativeChatItemBody | null): string | null {
  if (body?.kind === 'tool-call' && 'output' in body) {
    return body.output?.head ?? null
  }
  return body?.kind === 'diff' && 'patch' in body ? body.patch.head : null
}

/** A tool's output in an opened line: its head, and the whole of it on request. */
export function MobileNativeChatToolOutput({
  output,
  isError,
  fullOutputItemId
}: {
  output: string
  isError?: boolean
  fullOutputItemId?: string
}): React.JSX.Element {
  const source = useContext(MobileNativeChatItemSourceContext)
  const [full, setFull] = useState<string | null>(null)
  const [load, setLoad] = useState<Load>('idle')
  const clipped =
    full === null && (fullOutputItemId !== undefined || output.length > MAX_TOOL_DETAIL_LENGTH)
  const showFull = (): void => {
    if (fullOutputItemId === undefined || source === null) {
      setFull(output)
      return
    }
    setLoad('loading')
    readMobileNativeChatItem(source, fullOutputItemId)
      .then((body) => {
        setFull(outputOf(body) ?? output)
        setLoad('idle')
      })
      .catch(() => setLoad('failed'))
  }
  return (
    <View>
      <View style={[styles.toolResult, isError && styles.toolResultError]}>
        <Text style={styles.mono}>{full ?? truncateToolDetail(output)}</Text>
      </View>
      {clipped ? <ShowFull label="Show full output" load={load} onPress={showFull} /> : null}
    </View>
  )
}

/** `message` as drawn: whole once the reader asked for a reply the phone was sent shortened. */
export function useMobileNativeChatFullMessage(message: NativeChatMessage): {
  shown: NativeChatMessage
  showFull: React.JSX.Element | null
} {
  const source = useContext(MobileNativeChatItemSourceContext)
  const [texts, setTexts] = useState<(string | undefined)[] | null>(null)
  const [load, setLoad] = useState<Load>('idle')
  if (texts) {
    // Shortening cuts strings only, so the host's blocks line up with the row's one for one.
    const blocks = message.blocks.map((block, index) => {
      const text = texts[index]
      return isTextBlock(block) && text !== undefined ? { ...block, text } : block
    })
    return { shown: { ...message, blocks }, showFull: null }
  }
  if (message.shortened !== true || source === null) {
    return { shown: message, showFull: null }
  }
  const showFull = (): void => {
    setLoad('loading')
    readMobileNativeChatItem(source, message.id)
      .then((body) => {
        setTexts(
          body?.kind === 'message' && 'blocks' in body
            ? body.blocks.map((block) => (block.type === 'text' ? block.text : undefined))
            : []
        )
        setLoad('idle')
      })
      .catch(() => setLoad('failed'))
  }
  return {
    shown: message,
    showFull: <ShowFull label="Show full message" load={load} onPress={showFull} />
  }
}
