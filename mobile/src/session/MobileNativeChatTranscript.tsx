import { useCallback, useImperativeHandle, useMemo, type Ref } from 'react'
import { LegendList } from '@legendapp/list/react-native'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import { ArrowDown } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-native-chat-view-styles'
import type { MobileNativeChatViewProps } from './MobileNativeChatView'
import {
  buildMobileNativeChatTransientData,
  mobileNativeChatEmptyState
} from './mobile-native-chat-render-data'
import {
  mobileNativeChatPresentation,
  type MobileNativeChatPresentationEntry
} from './mobile-native-chat-presentation'
import { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'
import {
  MOBILE_NATIVE_CHAT_END_THRESHOLD,
  useMobileNativeChatListIntent
} from './use-mobile-native-chat-list-intent'
import type { useMobileNativeChatPinchGesture } from './use-mobile-native-chat-pinch-gesture'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import { MobileNativeChatLiveLine } from './MobileNativeChatLiveLine'

export type MobileNativeChatTranscriptHandle = { jumpToTail: () => void }
type Props = Pick<
  MobileNativeChatViewProps,
  | 'messages'
  | 'folded'
  | 'streaming'
  | 'streamingKey'
  | 'presentationKeys'
  | 'pending'
  | 'imagePreviewsByMessageId'
  | 'status'
  | 'error'
  | 'agent'
  | 'agentWorking'
  | 'structuredActivityUi'
  | 'turnIndicator'
  | 'workingStartedAt'
  | 'settledTurns'
  | 'turnJournal'
  | 'hasMore'
  | 'loadingEarlier'
  | 'onLoadEarlier'
  | 'onOpenFile'
  | 'transcriptIdentity'
> & {
  ref: Ref<MobileNativeChatTranscriptHandle>
  toolsExpanded: boolean
  fontScale: number
  pinchGesture: ReturnType<typeof useMobileNativeChatPinchGesture>['pinchGesture']
  lineYields: boolean
}

const restoreMessagePosition = (entry: MobileNativeChatPresentationEntry): boolean =>
  entry.kind === 'message'
// Keep native sentinel ownership stable, including while user gestures suppress following.
const VISIBLE_POSITION = { data: true, size: true, shouldRestorePosition: restoreMessagePosition }

/** The key owns the measured list, its disclosure, gesture state and pending work. */
export function MobileNativeChatTranscript(props: Props): React.JSX.Element {
  const {
    messages,
    folded,
    streaming,
    streamingKey,
    presentationKeys,
    pending,
    imagePreviewsByMessageId,
    status,
    error,
    agent,
    agentWorking,
    structuredActivityUi = false,
    turnIndicator,
    workingStartedAt,
    settledTurns,
    turnJournal,
    hasMore,
    loadingEarlier,
    onLoadEarlier,
    onOpenFile,
    toolsExpanded,
    fontScale,
    pinchGesture,
    transcriptIdentity,
    lineYields,
    ref
  } = props
  const { data } = useMemo(
    () =>
      buildMobileNativeChatTransientData({
        messages,
        folded,
        streaming,
        pending,
        imagePreviewsByMessageId
      }),
    [messages, folded, streaming, pending, imagePreviewsByMessageId]
  )
  const turns = useMobileNativeChatTurnDisclosure({
    messages: data,
    enabled: structuredActivityUi,
    isWorking: agentWorking === true,
    workingStartedAt,
    settledTurns,
    turnJournal,
    thinking: turnIndicator?.thinking === true,
    activityText: turnIndicator?.activityText ?? null,
    stopping: turnIndicator?.stopping === true,
    lineYields,
    scopeKey: transcriptIdentity
  })
  const presentation = useMemo(
    () => mobileNativeChatPresentation({ turns, streamingKey, presentationKeys }),
    [turns, streamingKey, presentationKeys]
  )
  const intent = useMobileNativeChatListIntent({ hasMore, loadingEarlier, onLoadEarlier })
  useImperativeHandle(ref, () => ({ jumpToTail: intent.jumpToTail }), [intent.jumpToTail])
  const renderItem = useCallback(
    ({ item }: { item: MobileNativeChatPresentationEntry }) => {
      if (item.kind === 'live-status') {
        return (
          <MobileNativeChatLiveLine
            line={item.line}
            onToggleReasoning={turns.onToggleReasoning}
            fontScale={fontScale}
            onOpenFile={onOpenFile}
          />
        )
      }
      return (
        <MobileNativeChatMessage
          message={item.message}
          toolsExpanded={toolsExpanded}
          fontScale={fontScale}
          onOpenFile={onOpenFile}
          structuredActivityUi={structuredActivityUi}
          onToggleTurn={turns.onToggleTurn}
          {...item.row}
        />
      )
    },
    [
      fontScale,
      onOpenFile,
      structuredActivityUi,
      toolsExpanded,
      turns.onToggleReasoning,
      turns.onToggleTurn
    ]
  )
  const empty = mobileNativeChatEmptyState(status, agent ?? null, error)
  if (status === 'loading' && messages.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.textSecondary} />
      </View>
    )
  }
  return (
    <GestureHandlerRootView style={styles.listWrap}>
      <GestureDetector gesture={pinchGesture}>
        <LegendList
          ref={intent.listRef}
          data={presentation}
          keyExtractor={(entry) => entry.key}
          renderItem={renderItem}
          recycleItems={false}
          initialScrollAtEnd
          maintainVisibleContentPosition={VISIBLE_POSITION}
          maintainScrollAtEndThreshold={MOBILE_NATIVE_CHAT_END_THRESHOLD}
          maintainScrollAtEnd={intent.following ? { animated: false } : false}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          onScroll={intent.onScroll}
          onScrollBeginDrag={intent.beginDrag}
          onScrollEndDrag={intent.endDrag}
          onMomentumScrollBegin={intent.beginMomentum}
          onMomentumScrollEnd={intent.endMomentum}
          scrollEventThrottle={16}
          ListHeaderComponent={
            hasMore ? (
              <Pressable
                style={styles.loadEarlier}
                onPress={intent.loadEarlier}
                disabled={loadingEarlier}
              >
                {loadingEarlier ? (
                  <ActivityIndicator size="small" color={colors.textMuted} />
                ) : (
                  <Text style={styles.loadEarlierText}>Load earlier messages</Text>
                )}
              </Pressable>
            ) : null
          }
          ListEmptyComponent={
            empty ? (
              <View style={styles.center}>
                <Text style={styles.emptyTitle}>{empty.title}</Text>
                <Text style={styles.emptySubtitle}>{empty.subtitle}</Text>
              </View>
            ) : null
          }
        />
      </GestureDetector>
      {intent.showJumpToTail ? (
        <Pressable
          accessibilityLabel="Scroll to latest"
          style={[styles.fab, styles.fabBottom]}
          onPress={intent.jumpToTail}
        >
          <ArrowDown size={18} color={colors.textPrimary} strokeWidth={2.2} />
        </Pressable>
      ) : null}
    </GestureHandlerRootView>
  )
}
