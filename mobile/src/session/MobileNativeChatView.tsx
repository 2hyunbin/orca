import { useCallback, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react-native'
import type { AskAnswerSelection, AskPrompt } from '../../../src/shared/native-chat-ask'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type {
  NativeChatLiveTurnIndicator,
  NativeChatSettledTurns
} from '../../../src/shared/native-chat-turn-status'
import type { NativeChatTurnJournal } from '../../../src/shared/native-chat-turn-membership'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-native-chat-view-styles'
import {
  mobileNativeChatEmptyState,
  type MobileNativeChatPendingItem
} from './mobile-native-chat-render-data'
import { useMobileNativeChatPinchGesture } from './use-mobile-native-chat-pinch-gesture'
import {
  mobileNativeChatComposerPlaceholder,
  useSettledMobileNativeChatInputLock
} from './use-mobile-native-chat-input-lease'
import { MobileNativeChatStopButton } from './MobileNativeChatStopButton'
import { MobileAgentWorkingIndicator } from './MobileAgentWorkingIndicator'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import { MobileNativeChatComposer } from './MobileNativeChatComposer'
import { MobileNativeChatPromptCard } from './MobileNativeChatPromptCard'
import { NO_QUEUED_SLOT, type MobileQueuedSlotProps } from './use-mobile-native-chat-queued-slot'
import type { MobileChatPermission } from './mobile-native-chat-permission'
import type { MobileChatQuestion } from './mobile-native-chat-question'
import type { MobileNativeChatSessionOptionPickersProps } from './MobileNativeChatSessionOptionPickers'
import type { MobileNativeChatStatus } from './use-mobile-native-chat-session'
import {
  MobileNativeChatTranscript,
  type MobileNativeChatTranscriptHandle
} from './MobileNativeChatTranscript'

/** Why the composer input is locked: the transport is disconnected, or the
 *  terminal subscription has not acknowledged its input lease yet. */
export type MobileNativeChatInputLockReason = 'disconnected' | 'waiting'

export type MobileNativeChatViewProps = MobileQueuedSlotProps & {
  /** Raw transcript, only for telling "still loading" from "loaded and empty". */
  messages: NativeChatMessage[]
  /** `messages` with noise stripped and tool turns folded in, from the overlay. */
  folded: NativeChatMessage[]
  status: MobileNativeChatStatus
  error?: string
  /** The read failed for good (damage, a newer Orca's chat): its error takes the whole pane. */
  readFailedFinally?: boolean
  /** Resolved agent for this chat; names the empty-state copy (desktop parity). */
  agent?: string | null
  agentWorking?: boolean
  canStop?: boolean
  /** Structured lane: per-turn "Working for N" status plus live tool progress,
   *  replacing the bridge lane's static three-dot working row (desktop parity). */
  structuredActivityUi?: boolean
  /** What labels the live turn's one indicator row (structured lane only). */
  turnIndicator?: NativeChatLiveTurnIndicator | null
  /** Structured lane: host-recorded turn timing feeding the per-turn status rows. */
  workingStartedAt?: number | null
  settledTurns?: NativeChatSettledTurns | null
  /** Structured lane: the journal that places each row in its turn. */
  turnJournal?: NativeChatTurnJournal | null
  /** Interrupt the agent mid-turn (shown as a Stop button on the working bar). */
  /** Interrupt a provider turn. */
  onStop?: () => void
  /** Live partial assistant text to show as an in-progress bubble, already gated
   *  by the overlay against the transcript catching up. */
  streaming: string | null
  streamingKey: string
  presentationKeys: Readonly<Record<string, string>>
  transcriptIdentity: string
  hasMore?: boolean
  loadingEarlier?: boolean
  onLoadEarlier?: () => void
  onSend: (text: string) => Promise<boolean>
  /** Route identity used to fence accepted sends that settle after a tab/view switch. */
  sendSurfaceId: string
  /** Reads the retained route's focus generation for accepted-send fencing. */
  getSendCompletionGeneration: () => number
  /** Reads user draft mutations from the route-owned controller. */
  getComposerEditGeneration: () => number
  /** Accepted user echoes awaiting transcript replacement, including image previews. */
  pending: MobileNativeChatPendingItem[]
  /** Local photo URIs retained when the authoritative transcript replaces an
   *  optimistic image bubble. */
  imagePreviewsByMessageId?: Record<string, string[]>
  /** Controlled composer text (owned by the route so dictation can write to it). */
  composerText: string
  onComposerTextChange: (text: string) => void
  onAttachImage?: () => void
  /** Pending image attachments shown as composer thumbnails until the next send. */
  attachments?: PendingNativeChatImage[]
  onRemoveAttachment?: (id: string) => void
  isAttaching?: boolean
  onMicPress?: () => void
  micActive?: boolean
  dictationMode?: string
  onMicPressIn?: () => void
  onMicPressOut?: () => void
  inputLockReason?: MobileNativeChatInputLockReason | null
  /** Route-reported send failure (answer cards, permission replies, stop). Shares the
   *  inline banner with a rejected composer send, so one failure paints once. The
   *  route routes these here only while this view is mounted, and falls back to its
   *  toast otherwise — a deferred failure must not land on an unmounted banner. */
  sendErrorMessage?: string | null
  /** Clears `sendErrorMessage` once a later send is accepted. */
  onClearSendError?: () => void
  filePaths?: string[]
  onNeedFiles?: (query: string) => void
  /** Model/session-option pickers for the composer action row (desktop parity). */
  sessionOptions?: MobileNativeChatSessionOptionPickersProps | null
  /** A pending agent question/permission detected from live status, shown as a
   *  native card above the composer; answering sends text to the agent. */
  /** Structured AskUserQuestion prompt parsed from the transcript (preferred over
   *  the heuristic question card). */
  ask?: AskPrompt | null
  /** Stable key for the ask card. Dismissal state lives in the controller (it
   *  must survive this subtree unmounting on a chat↔terminal toggle). */
  askKey?: string | null
  /** Hide the answered/dismissed ask until a different question arrives. */
  onDismissAsk?: () => void
  /** Deliver the ask answer as per-question selections; the send hook turns them
   *  into selector keystrokes (Claude) or pasted label text (other agents). */
  onAnswerAsk?: (prompt: AskPrompt, selections: AskAnswerSelection[]) => Promise<boolean>
  onCancelAsk?: () => Promise<boolean>
  /** Cancel a structured approval/question with exact item identity when supported. */
  onCancelPrompt?: (prompt?: { itemId: string; expectedRevision: number }) => Promise<boolean>
  onCollapseAsk?: () => void
  onCollapsePrompt?: () => void
  collapsedPrompt?: { title: string; expand: () => void } | null
  question?: MobileChatQuestion | null
  onAnswerQuestion?: (text: string) => Promise<boolean>
  permission?: MobileChatPermission | null
  promptKey?: string | null
  onRespondPermission?: (send: string) => Promise<boolean>
  /** Open a worktree file tapped in agent markdown. */
  onOpenFile?: (relativePath: string) => void
  /** Pixels to lift the composer by when the soft keyboard is open. The route
   *  owns keyboard tracking (the app uses manual lift, not KeyboardAvoidingView). */
  keyboardInset?: number
}

export function MobileNativeChatView({
  messages,
  folded,
  status,
  error,
  readFailedFinally = false,
  agent,
  agentWorking,
  canStop = agentWorking,
  structuredActivityUi = false,
  turnIndicator = null,
  workingStartedAt,
  settledTurns,
  turnJournal = null,
  onStop,
  streaming,
  streamingKey,
  presentationKeys,
  transcriptIdentity,
  hasMore,
  loadingEarlier,
  onLoadEarlier,
  onSend,
  getSendCompletionGeneration,
  getComposerEditGeneration,
  pending,
  imagePreviewsByMessageId,
  composerText,
  onComposerTextChange,
  onAttachImage,
  attachments,
  onRemoveAttachment,
  isAttaching,
  onMicPress,
  micActive,
  dictationMode,
  onMicPressIn,
  onMicPressOut,
  inputLockReason,
  sendErrorMessage,
  onClearSendError,
  filePaths,
  onNeedFiles,
  sessionOptions,
  ask,
  askKey,
  onDismissAsk,
  onAnswerAsk,
  onCancelAsk,
  onCancelPrompt,
  onCollapseAsk,
  onCollapsePrompt,
  collapsedPrompt,
  question,
  onAnswerQuestion,
  permission,
  promptKey,
  onRespondPermission,
  queuedSlot: { cards: queuedCards, composerInputRef: inputRef } = NO_QUEUED_SLOT,
  onOpenFile,
  keyboardInset = 0
}: MobileNativeChatViewProps): React.JSX.Element {
  const insets = useSafeAreaInsets()
  const [toolsExpanded, setToolsExpanded] = useState(false)
  // Lift the composer clear of the keyboard, plus the bottom safe-area so it
  // never sits under the home indicator / nav bar (mirrors the terminal dock).
  const bottomPad = keyboardInset > 0 ? keyboardInset + insets.bottom : insets.bottom
  const { fontScale, pinchGesture } = useMobileNativeChatPinchGesture()

  const transcriptRef = useRef<MobileNativeChatTranscriptHandle | null>(null)
  const handleSend = useCallback(
    async (text: string): Promise<boolean> => {
      const transcript = transcriptRef.current
      const generation = getSendCompletionGeneration()
      const accepted = await onSend(text)
      if (
        accepted &&
        transcript !== null &&
        transcriptRef.current === transcript &&
        generation === getSendCompletionGeneration()
      ) {
        onClearSendError?.()
        transcript.jumpToTail()
      }
      return accepted
    },
    [onSend, onClearSendError, getSendCompletionGeneration]
  )
  const emptyState = mobileNativeChatEmptyState(status, agent ?? null, error)

  const lockReason = useSettledMobileNativeChatInputLock(inputLockReason)
  // Why only Send, terminal-backed only: that send types into the agent's prompt and can answer it,
  // while drafting never does; the host queues a structured send behind it.
  const expandedPromptOwnsSend =
    !structuredActivityUi && !collapsedPrompt && (ask ?? permission ?? question) != null
  const emptyStateView = emptyState ? (
    <View style={styles.center}>
      <Text style={styles.emptyTitle}>{emptyState.title}</Text>
      <Text style={styles.emptySubtitle}>{emptyState.subtitle}</Text>
    </View>
  ) : null

  // Whatever was already on screen: nothing here can act on a chat that cannot load, and its words
  // say why once, as a fresh open's do.
  if (readFailedFinally && emptyStateView) {
    return <View style={[styles.root, { paddingBottom: bottomPad }]}>{emptyStateView}</View>
  }

  return (
    <View style={[styles.root, { paddingBottom: bottomPad }]}>
      <MobileNativeChatTranscript
        key={transcriptIdentity}
        ref={transcriptRef}
        {...{
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
          structuredActivityUi,
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
          transcriptIdentity
        }}
        lineYields={structuredActivityUi && (ask != null || permission != null || question != null)}
      />
      {queuedCards}
      <MobileNativeChatPromptCard
        key={promptKey ?? undefined}
        {...{ ask, askKey, onDismissAsk, onAnswerAsk, onCancelAsk, onCancelPrompt, onCollapseAsk }}
        {...{ permission, onRespondPermission, question, onAnswerQuestion, onCollapsePrompt }}
        collapsedPrompt={collapsedPrompt}
      />
      <View style={styles.chromeRow}>
        <View style={styles.chromeLeft}>
          {agentWorking && !structuredActivityUi ? <MobileAgentWorkingIndicator /> : null}
          <Pressable
            style={({ pressed }) => [styles.chromeToggle, pressed && styles.pressed]}
            onPress={() => setToolsExpanded((v) => !v)}
            hitSlop={8}
          >
            {toolsExpanded ? (
              <ChevronsDownUp size={14} color={colors.textMuted} strokeWidth={2} />
            ) : (
              <ChevronsUpDown size={14} color={colors.textMuted} strokeWidth={2} />
            )}
            <Text style={styles.chromeToggleLabel}>{toolsExpanded ? 'Collapse' : 'Tools'}</Text>
          </Pressable>
        </View>
        {canStop ? (
          // Only this phone's own request holds Stop: a repeat is how a stuck stop escalates.
          <MobileNativeChatStopButton
            onStop={onStop}
            held={agentWorking === true && turnIndicator?.stopRequestInFlight === true}
          />
        ) : null}
      </View>
      {sendErrorMessage ? (
        // This banner is the only channel for a send failure — announce it.
        <View
          style={styles.sendError}
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
        >
          <Text style={styles.sendErrorText}>{sendErrorMessage}</Text>
        </View>
      ) : null}
      <MobileNativeChatComposer
        structuredCommands={
          structuredActivityUi ? (sessionOptions?.controller.conversationCommands ?? []) : undefined
        }
        value={composerText}
        onChangeText={onComposerTextChange}
        onSend={handleSend}
        sendSurfaceId={transcriptIdentity}
        {...{ getSendCompletionGeneration, getComposerEditGeneration, inputRef }}
        agent={agent}
        sessionOptions={sessionOptions}
        onAttachImage={onAttachImage}
        attachments={attachments}
        onRemoveAttachment={onRemoveAttachment}
        isAttaching={isAttaching}
        onMicPress={onMicPress}
        micActive={micActive}
        dictationMode={dictationMode}
        onMicPressIn={onMicPressIn}
        onMicPressOut={onMicPressOut}
        disabled={lockReason !== null}
        sendDisabled={expandedPromptOwnsSend}
        placeholder={mobileNativeChatComposerPlaceholder(lockReason, turnIndicator?.afterStop)}
        filePaths={filePaths}
        onNeedFiles={onNeedFiles}
      />
    </View>
  )
}
